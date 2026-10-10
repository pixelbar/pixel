# Pixel architecture

> Status: **living draft**. The bot is built; Azure bootstrap is applied; Container App `pixel-dev` is live. Identity and access control have their own document: [`identity-and-access.md`](identity-and-access.md).

## Goals

1. **Useful to Pixelbar members and visitors.** Show space status, surface events, answer common questions.
2. **Platform-independent core.** Features are written once. Discord comes first. Later platforms come in two kinds: interactive ones (for example Telegram) and outbound-only ones (for example Mastodon). Each kind is a separate adapter.
3. **Secure tiers.** `guest` < `friend` < `member` < `admin`, enforced in one place. See the identity doc.
4. **Simple to operate.** One container per environment (`dev` and `prod`), one command to run locally, errors visible in Sentry.
5. **Easy to contribute to.** A new feature is one folder and needs no platform plumbing.

## Phase 1 scope

| In scope                                                    | Not yet                                             |
| ----------------------------------------------------------- | --------------------------------------------------- |
| Core: commands, access, dispatcher, registry, announcer     | Telegram, Mastodon, other adapters                  |
| Discord adapter (interactive + publisher + calendar)        | Account linking across platforms                    |
| Tiers from `config/admins.yaml` and `config/members.yaml`   | Reading Discord roles (never: roles are only mirrored to) |
| SpaceAPI status, Discord events, info, help, whoami         | A database (none: access, schedules and planned linking are files) |
| Sentry, pino, `just`, CI, Terraform bootstrap + `dev` stack | Remaining CD (#10: Sentry org, `ARM_*`), prod (#12) |

**Non-goals:** horizontal scaling, input from broadcast platforms, LLM chat, languages other than English.

## High-level design

Pixel follows a **ports-and-adapters** design. Adapters translate between a platform and the core. Features only know about the core.

```
                  Discord
                     │  ▲
                     ▼  │
   ┌──────────────────────────────────────────┐        later:
   │ adapters/discord                         │   ┌───────────────────┐
   │  interactions → PlatformActor + command  │   │ adapters/telegram │ (interactive)
   │  Reply → Discord messages                │   │ adapters/mastodon │ (publisher only)
   │  Publishers (live + timeline channels)   │   └───────────────────┘
   │  CalendarSource (guild scheduled events) │
   └───────┬──────────────────────────▲───────┘
           │                          │ Announcement
           ▼                          │
   ┌──────────────────────────────────┴───────┐
   │ core                                     │
   │  identity (TierSources) → dispatcher     │
   │  (rate limit → authorize → handler)      │
   │  registry · announcer                    │
   │  errors · ports                          │
   └───────────────────┬──────────────────────┘
                       ▼
   ┌──────────────────────────────────────────┐
   │ features/*  help · ping · status ·       │
   │             events · info · whoami       │
   └───────────────────┬──────────────────────┘
                       ▼
   ┌──────────────────────────────────────────┐
   │ services/*  spaceapi · access config ·   │
   │             info content                 │
   └──────────────────────────────────────────┘

   observability/ (Sentry + pino) wraps every layer
```

## Core concepts

```ts
// core/access.ts
type Tier = "guest" | "friend" | "member" | "admin";
type ChatContext = "dm" | "group";
type Access = { minTier: Tier; contexts?: ChatContext[] };   // minTier is required

type PlatformActor = {
  platform: Platform;            // "discord" for now
  userId: string;                // immutable platform ID: the only thing used for auth
  displayName: string;           // logs and display only
  handle?: string;               // unique username (Discord handle), logs only
  chat: ChatContext;
};

type Principal = PlatformActor & { tier: Tier };

// core/command.ts
type CommandDefinition = {
  name: string;
  description: string;
  access: Access;
  options?: CommandOption[];     // string | integer | boolean | user; string and integer can have `suggest`
  private?: boolean;             // default reply visibility
  placeholder?: Reply;           // shown at once (e.g. "Checking…"), then replaced by the result
  handler: (ctx: CommandContext) => Promise<Reply>;
};

// Or a group, e.g. /admin status: `subcommands` instead of a handler. Each subcommand has
// its own name, access, options, private, placeholder and handler. A group can also hold
// subgroups (/admin capabilities grant): { name, description, access, subcommands }.
// Access is a floor at every level: the registry rejects a looser child, and the dispatcher
// checks every level.
type GroupCommand = { name; description; access: Access; subcommands: (SubcommandDefinition | SubgroupDefinition)[] };

// access: { minTier, contexts?, capability? } — a capability is a named permission that must
// hold as well as the tier (core/capabilities.ts). Principal.capabilities is always empty for guests.

type CommandContext = {
  args: Record<string, string | number | boolean | undefined>;   // validated against options
  users: Record<string, ResolvedUser>;   // people picked through `user` options (id, displayName, handle?, isBot)
  principal: Principal;
  logger: Logger;
  availableCommands: CommandSummary[];   // only what this principal may run (for /help)
};
// Features receive their dependencies through their factory function
// (constructor injection), not through the context.

// core/reply.ts: adapters render this however their platform allows
type Reply = {
  text?: string;
  embeds?: Embed[];              // Embed.accent: brand | positive | negative | warning | neutral
  private?: boolean;             // Discord: ephemeral
};

// core/announcement.ts: what features announce and publishers receive
type Announcement = SpaceStatusAnnouncement;   // a union that grows with each new kind
type SpaceStatusAnnouncement = {
  kind: "space.status";
  state: "open" | "closed";
  at: Date;                      // when Pixel saw the change
  openedAt: Date | null;         // for "closed": when this stretch of being open began, if known
  text: string;                  // short plain text for platforms without rich formatting
};
type Publisher = {
  id: string;                    // "discord:live", "discord:timeline", …
  publish(a: Announcement): Promise<void>;
  reconcile?(s: SpaceSnapshot): Promise<void>;   // at startup: fix stale posts, never post new ones
};

// core/feature.ts
type Feature = {
  name: string;
  commands?: CommandDefinition[];
  start?: () => Stop;            // background work, started once the adapters are ready
};
```

### Pieces of the core

- **Registry** collects features. It refuses to register a command without `access.minTier` and refuses duplicate names.
- **IdentityService** asks each `TierSource` for a tier and keeps the highest. Phase 1 has only the config source.
- **Dispatcher** handles each command in order:
  1. rate-limit, which is cheap and protects the tier sources
  2. resolve identity
  3. check access, logging denials
  4. validate the arguments against the declared options
  5. send the command's placeholder, if it has one, through the adapter's `onPending` hook. This only happens once the checks above pass, so denied callers never see it
  6. call the handler
  7. map errors to replies, reporting unexpected ones to Sentry with the command's tags
  8. log every executed command as an action (`command.executed`), recording who did it (ID, display name, handle), their tier, the outcome and the duration
- **Announcer** sends each announcement to every registered publisher. Adapters register their publishers once they're ready. One publisher failing never blocks the others and never throws: the failure is logged and reported to Sentry, tagged `announcer:<publisher id>`. Calls run one at a time, in order, so a startup `reconcile` can't interleave with an announcement. There's deliberately no routing table yet: with one platform it would be speculative, and routing becomes config once a second publisher exists.
- **Background work:** a feature can declare `start()`. The bot calls every feature's `start()` once Discord is ready, so the publishers already exist, and calls the returned stop function on shutdown. There's deliberately no generic scheduler yet: the status service already polls on its own, and one will make sense when a second job appears (such as the nightly role check in #14).
- **Rate limiter** keeps an in-memory token bucket for each user. That is enough because there is a single replica.
- **Errors:** `UserFacingError` is shown to the user and not reported. Anything else is reported to Sentry, and the user gets a generic reply. Errors outside commands, from background work or platform clients, go through `ErrorReporter.captureBackground` and are tagged with their source.

## Discord adapter

- **discord.js v14, slash commands only.** Intents: `Guilds` only, which isn't privileged. No `MessageContent`. Scheduled events are read over REST, which needs no intent.
- **Guild allow-list:** interactions from any guild other than `DISCORD_GUILD_ID` are refused, and the bot leaves other guilds. Slash commands are guild-only (they aren't available in DMs). Pixel does send DMs when a capability is granted or revoked (see below).
- **Autocomplete:** a string or integer option can have a `suggest` function (never together with fixed `choices`). It runs while someone types and returns up to 25 `{ name, value }` suggestions from live data, and it can see the options already filled in, so the actions offered can depend on the device chosen. `Dispatcher.suggest` runs it through the **same access gates as the command**, so people who can't run a command get an empty list (logged as `command.suggest_denied`), and it has its own, more generous rate limit so typing can't use up the budget for commands. A slow (over 2.5 s, Discord's limit is 3) or failing function gives an empty list. What was typed is never logged. **Suggestions are not validation:** Discord doesn't check that a submitted value came from them, so the command validates what it receives as usual.
- **Capability DMs:** when `AccessStore.apply` actually grants or revokes capabilities, Pixel DMs that Discord user ID through a `DirectMessenger` port (`core/ports/direct-message.ts`, implemented here). Mentions stay off. A closed inbox or other send failure is logged (`capability.dm_failed`, IDs only) and never fails the `/admin` command or tells the target why.
- **Mapping:** `CommandDefinition.options` become Discord slash command options. A group becomes native subcommands (`/admin status`), and a `user` option becomes Discord's user picker. The handler gets the picked user's immutable ID as the arg, and the adapter resolves their name and whether they are a bot. Bots are refused unless the option sets `allowBots`. Targets are identified by ID only, never by name. `Reply` becomes the message content plus embeds, truncated to Discord's limits. `private` becomes the ephemeral flag. **Mentions are always disabled** (`allowedMentions: { parse: [] }`), so no reply can ping `@everyone`.
- **Acknowledging within 3 seconds:** Discord requires a response within 3 s. Pixel acknowledges with whichever comes first:
  - the command's placeholder, which is posted straight away
  - `deferReply()`, if the handler is still running after 1.5 s (this uses the command's default visibility)
  - the final reply
- **Placeholders and deferrals are edited into the result.** Edits always set both content and embeds, because Discord keeps any field an edit leaves out.
- **Visibility can't change after the first response.** If the first response was public but the result is private, Pixel deletes it and sends the result as an ephemeral follow-up. A private result is never shown publicly.
- **Accents:** `Embed.accent` sets the colour of the embed's side bar.
- **Registration:** `just register` runs a script that builds the command list from the registry and sends it with a REST PUT to the guild. Commands are registered to the guild only, because Pixel serves just one, so updates show up instantly.
- **Publishers:** two styles of space announcement, each with its own channel setting, and either, both or neither can be on. They can also be the same channel. All posts are embeds with mentions disabled, and times use Discord's timestamp markup, so everyone sees them in their own time zone.
  - **Timeline** (`DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID`): a new post for every open and every close, never edited, so a status-only channel reads as a log of exactly when the space opened and closed. "🟢 Pixelbar opened" and "🔴 Pixelbar closed", with how long it was open if known.
  - **Live** (`DISCORD_ANNOUNCE_LIVE_CHANNEL_ID`): opening makes a new "🟢 Pixelbar is open" post; closing **edits that same post** to "🔴 Pixelbar is closed: was open from … to …". Opening again makes another new post. A closed post is never turned back into an open one, so nobody is confused by a message that flips back.
  - **Finding the open post to edit.** Pixel uses the message ID it remembered in `announcements.state` (so it works even if the post is buried in a busy channel), and also looks through its own recent messages in the channel (so it still works if the remembered ID was lost, for example after a deploy, and a deleted post simply isn't found). Only posts carrying the live footer count, so a `/status` reply can't be mistaken for one. Pixel keeps the invariant that at most one post, the newest, says "open".
  - **Startup checks.** For each channel, Pixel checks it exists, is a text channel in the Pixelbar server, and that the bot has the permissions it needs: View Channel, Send Messages and Embed Links, plus Read Message History for the live style. If not, that publisher stays off with a clear log and a Sentry report, and everything else keeps working. No new Discord intents are needed.
- **Bot status** (`features/bot-status`, `adapters/discord/bot-status.ts`): Pixel says when it comes online and goes offline, in the announcements channel (`DISCORD_ANNOUNCEMENTS_CHANNEL_ID`, or `DISCORD_ANNOUNCE_BOT_CHANNEL_ID` to post elsewhere; neither set means off).
  - **Online is a new post each time** ("🟢 Pixel is online"), so every start, deploy and restart is visible and the channel reads as a history of runs. It shows the version (`package.json`), the git commit, the branch when it isn't `main`, the environment when it isn't `prod`, **Where** (`local` or `cloud`, from `PIXEL_RUNTIME`), and a short public status: Discord connected, Home Assistant (when set up: connected, not connected yet or off, never the reason) and whether SpaceAPI answered. It's posted once Discord is ready and Home Assistant has connected, or after 10 seconds, whichever comes first.
  - **Going offline edits that run's post** to "🔴 Pixel is offline: was online from … to … (uptime), reason", so each run is one message and the newest one always tells the truth. It's sent on SIGTERM or SIGINT, before disconnecting, with at most 5 seconds' wait so it never holds up a shutdown.
  - **A crash can't say goodbye.** On the next start, any of Pixel's posts still saying online (found by the remembered ID in `bot-status.state`, and by title and footer among its recent messages, like the live space post) are edited to "⚠️ Pixel stopped unexpectedly" before the new online post goes up.
  - **Where the commit and branch come from:** `PIXEL_GIT_SHA` and `PIXEL_GIT_BRANCH`, passed in by CI and `just docker-build` as build arguments (an image has no `.git`). From a checkout without them, Pixel asks git; anything it can't find is left out.
  - It goes through the `Announcer` as a `bot.status` announcement; the space publishers ignore it, and it needs the same permissions as the live style (including Read Message History).
- **Calendar source:** once connected, the adapter plugs the server's Discord scheduled events into the core `Calendar`. It reads them over REST on every call, needing no extra intents or permissions. (discord.js only skips the request when asked for one event by ID, which this never does.) Voice and stage channel names come from discord.js's channel cache, which Discord keeps current through gateway updates, so a renamed channel is right immediately. `calendar-map.ts` (pure, fully tested) maps each Discord event to a neutral `CalendarEvent`: external events use their location text, voice and stage events use the channel's name, finished and cancelled events are dropped, and recurrence rules become plain words ("weekly on Tuesday"). Discord returns a recurring event once, showing its next occurrence.

## Home Assistant (a client, not an adapter)

Pixel can read and control a Home Assistant (HA) instance: lights, switches, doors. Unlike Discord this is not a place where commands come from. Pixel is the client, and features reach HA only through the core `Home` (`core/home.ts`), the same way they use the calendar. The adapter in `adapters/home-assistant/` is the **only** place that imports the official `home-assistant-js-websocket` library, and it plugs a backend into `Home` at startup.

- **Connection:** `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN`, a long-lived token. Both unset means off, and only one set stops startup. It connects in the background and reconnects forever, so a slow or absent HA never holds up the bot, and it doesn't count towards `/healthz`: HA being down shouldn't restart Pixel. On Azure, prefer a **Tailscale sidecar** so the container reaches HA on the LAN (#9, #43). A **Nabu Casa** URL still works and is what local/dev use today.
- **A non-admin token:** HA can't scope a token, so a long-lived token can do whatever its user can. Use a **non-admin** HA user: that blocks the admin-only commands. Pixel asks HA whose token it is (`auth/current_user`) and warns, in the logs and Sentry, if it belongs to an admin. `/admin status` shows the warning too. The real fence is Pixel's own allow-list of devices (below).
- **Fails closed:** while HA isn't connected, or the token was refused, a call fails at once with a plain message. Nothing is queued, nothing is retried (a late unlock must never happen), and every call has a time limit. An outage is reported once, not on every command.
- **No cache:** every read asks HA, so a change in HA shows on the next read.
- **Errors are translated:** the library throws numbers (connection problems) and plain `{ code, message }` objects (HA's own errors). The adapter turns them into `HomeUnavailableError` and `HomeRequestError` with fixed, safe messages. The token and the address never appear in a message, a log line or Sentry (the token is scrubbed there too).
- **After a refused token:** the connection is off until `/admin reload` re-checks it, so a replaced token takes effect without a restart.
- **Tests** run against `src/testing/fake-home-assistant.ts`, a stand-in server that speaks HA's WebSocket protocol, never a real HA.

### Devices and kinds

Pixel never offers "any entity". The devices it may touch are listed in `config/home-assistant/devices.yaml` (gitignored; `devices.example.yaml` is committed and documented). Each device has:

- a **name** people type (`front-door`), unique, lowercase words joined by `-`;
- an **entity** (`lock.front_door`), unique, whose domain must match the kind;
- a **kind**, defined in code, which decides what can be done and how;
- the **actions** allowed, a subset of the kind's. Leaving them out means read-only: nothing is allowed unless it's listed;
- an optional description, and `minTier` (`friend`, `member` or `admin`, default `member`; never guest).

**Kinds** live in `src/core/home-kinds/`: light, switch, door (lock, unlock, open) and sensor (read-only). A kind is plain data: its HA domains, its actions (the HA service each calls and the states that mean it worked) and the capability that allows acting on it (`ha-lights`, `ha-doors` and so on, which the kind registers with the others). Who may do what is one rule in `core/home-access.ts`: see "Home Assistant devices" in `identity-and-access.md`. To add a kind, write a file like `light.ts` and add it to `HOME_KINDS`. The devices file, commands and autocomplete all read that list. `defineKinds` rejects a malformed kind when the code starts.

The file **fails closed** like the access files: when `HOME_ASSISTANT_URL` is set and the file is missing or invalid, Pixel doesn't start. Errors name the file, the position and the field, never a value, because the file describes the building. `/admin reload` re-reads it, and an invalid edit keeps the old list. At startup and on reload, Pixel warns about devices whose entity HA doesn't know (a typo), and `/admin status` shows how many devices are allowed. `just validate-config` checks it too.

### The inventory (known, not usable)

Alongside the allow-list, Pixel keeps an **inventory** of everything Home Assistant has that it has a kind for, in `config/home-assistant/inventory.yaml` (gitignored, rewritten on every sync). It exists so a person can see what's there, copy an entry into `devices.yaml` and give it a tier and actions, and so later features (richer `/status`, sensors) have the information to hand.

It is **not an allow-list**, and nothing reads it to decide anything. Entries have no tier and no actions, the file is never loaded back into Pixel, and the inventory is never offered by a command or autocomplete. A device is usable only when a person has listed it in `devices.yaml`.

- **When:** once Home Assistant has connected, then every `PIXEL_HOME_SYNC_MINUTES` (default 60; 0 means only at startup and on `/admin reload`). A failed run is skipped, not retried: the next run is the retry. An outage is logged once, and the old file stays.
- **What:** entities in a domain that has a kind (light, switch, lock, sensor, binary_sensor), leaving out those Home Assistant files as config or diagnostic and those someone hid. Each entry has a suggested `name` (a valid, unique device name made from the friendly name), the `entity`, the `kind`, the friendly name and the area. It has no state, because that changes constantly. Entries already in `devices.yaml` are marked `inDevicesFile`. At most 1000 entries, sensors being the first cut.
- **How:** it reads the same compact entity list Home Assistant's own app uses, which a non-admin token may read. If that list can't be read the run fails rather than guessing which entities are setup ones. The file is written atomically (mode 0600), and only when something other than the time changed. Names come from Home Assistant and are cleaned before they're written.
- `/admin status` shows how many are known and when it last synced, and `/admin reload` syncs now.

## Services and ports

| Service / port   | Purpose                              | Implementation                                                    |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `accessConfig`   | Admin and member lists               | Loads and validates the two YAML files at startup (`ConfigTierSource`). Capability grant/revoke also DMs the person via `DirectMessenger` (`core/ports/direct-message.ts`) |
| `spaceStatus`    | Is the space open?                   | `services/space-status.ts`. `checkNow()` asks `SPACEAPI_URL` (SpaceAPI v0.13) live, with a 5 s timeout, a size cap and validation. Overlapping checks share one request. Background polling every 30 s tracks when the state changed, and `onChange` fires on open↔closed flips, with how long the previous state lasted. The last state and its time are saved to `space.state` and restored on startup (below). After 10 consecutive failures (about 5 minutes) it reports once, and it logs when SpaceAPI recovers |
| `calendar`       | Upcoming events                      | `core/calendar.ts`. A neutral `CalendarEvent` and a `CalendarSource` that an adapter plugs in once it's ready (like announcement publishers), so before that `/events` says the calendar isn't available. **Nothing is cached**: every call asks the source, so a renamed or rescheduled event shows up straight away. If the source fails that's an error (`CalendarUnavailableError`), never an out-of-date list; it's logged, and reported to Sentry once per outage rather than on every command |
| `infoContent`    | `/info` topics                       | `services/info-content.ts`. Loads and validates the markdown files in `content/info/` at startup (see below). Invalid content stops startup, and CI loads the real content too |

Pixelbar's SpaceAPI response has `state.open` but no `lastchange`, so Pixel records when it saw each change and remembers it in `space.state` (YAML, in `PIXEL_DATA_DIR`, default `data/`). It's written only when the state changes, atomically (temp file and rename).

On startup the saved state is trusted only once a live reading agrees with it:
- **Same state:** the saved "since" is kept, so a restart doesn't lose it.
- **Different state:** the space changed while Pixel was down, so when is unknowable. "Since" is cleared and **no change event fires**, so a restart never announces a stale change. A live post that still says "open" is corrected at startup (see Announcing changes).
- **Missing, malformed or unreadable file:** Pixel starts fresh and logs a warning. Unlike the access lists this is not fail-closed: the file only affects the "open for 2h" text, so it must never stop the bot. A saved time in the future (clock change or hand-edit) is ignored.
- **Can't write:** checks carry on, and the failure is logged, and reported to Sentry once.

The [spaceapi.io directory](https://api.spaceapi.io/openapi.json) was considered as a source of "last changed", but its `lastSeen` is when the directory last *reached* the endpoint (about every minute), not when the state changed. It also keeps no history.

## Phase 1 features

| Feature   | Commands / jobs              | Tier   | Built | Notes                                               |
| --------- | ---------------------------- | ------ | ----- | --------------------------------------------------- |
| `help`    | `/help`                      | guest  | ✅    | Lists only the commands the caller can use          |
| `ping`    | `/ping`                      | guest  | ✅    | Version                                             |
| `whoami`  | `/whoami`                    | guest  | ✅    | Private reply: your ID and tier                     |
| `admin`   | `/admin status`              | admin  | ✅    | Private reply: version, uptime, access-list counts (no IDs) |
| `admin`   | `/admin reload`              | admin  | ✅    | Re-reads `admins.yaml` and `members.yaml` after hand edits. Keeps the old data if they're now invalid |
| `admin`   | `/admin level set user: level: [reason:]` | admin | ✅ | Makes someone `member`, `friend` or `guest`. Private reply with before and after. Refuses admins and bots, and says so when nothing would change |
| `admin`   | `/admin level get user:`         | admin  | ✅    | Private. Level, where it comes from (admins file, members file, not listed), capabilities, the note and, when roles are mirrored, their Discord roles with any mismatch. Lookups are logged |
| `admin`   | `/admin sync [user:]`        | admin  | ✅    | Sets the mapped Discord roles from Pixel's data, for one person or everyone in Pixel's lists. Pixel always wins |
| `admin`   | `/admin capabilities grant\|revoke user: capability: [reason:]` | admin | ✅ | Gives or takes a named permission. Picked from the registry in `features/capabilities.ts`, audited, refused for guests and bots. Says so when nothing would change. The person is DMed on an actual change; a closed inbox is logged and does not fail the command |
| `admin`   | `/admin capabilities list [user:]` | admin | ✅ | Private. The registered capabilities with holder counts, or one person's |
| `status`  | `/status`                    | guest  | ✅    | Public. A "Checking…" box, then a live answer: open (green) or closed (red), and how long (if Pixel saw the change) |
| `status`  | background: announce changes | n/a    | ✅    | Posts to the live and/or timeline channels (see below) |
| `events`  | `/events`                    | guest  | ✅    | Public. What's on now, then the next events (5 at most), with when, how soon, where and how often it repeats |
| `info`    | `/info [topic]`              | guest  | ✅    | Public. Short answers about Pixelbar from `content/info/`, with no topic it lists them |
| `home`    | `/ha list`                   | friend | ✅    | Private. The devices you may use (by each device's tier floor), grouped by kind, with their live state. Unavailable and unknown show as themselves. Says so when nothing is available to you, or when Home Assistant isn't set up |
| `home`    | `/ha status device:`         | friend | ✅    | Private. One device's live state, when it last changed and a few details for its kind (brightness, battery, the unit of a reading). `device` autocompletes, offering only what you may see. An unknown device and one you may not see get the same generic answer. Looking at a door is logged |
| `home`    | `/ha set device: state:`     | friend | ✅    | Private. Changes a device, such as `on` or `off` for a light. Needs the device's tier floor and `ha-admin` or the kind's capability, and an action the devices file allows. Both options autocomplete: `state` offers what that device allows, and what you may run. Reports what really happened. Doors are switched off for now |
| `home`    | `/ha open door:`             | member | ✅    | Private. Opens a door: `unlock` if the devices file allows it, otherwise `open` (unlatch). Needs `ha-doors` or `ha-admin`. `door` autocompletes with only the doors you may open. Refused while `/admin doors` is off |
| `admin`   | `/admin doors off\|on`        | admin  | ✅    | Private. The emergency switch for door control from Pixel, for everyone, at once. Remembered across restarts. Shown in `/admin status` |
| `schedules` | `/schedule message channel: when: [repeat:] [days:] [mentions:] [name:]` | member + `schedule-posts` | ✅ | Private. Opens a form for the text, then schedules a message in a channel. See "Scheduled posts" |
| `schedules` | `/schedule poll channel: when: [repeat:] [days:] [duration:] [multiple:] [name:]` | member + `schedule-posts` | ✅ | Private. Opens a form for the question and answers, then schedules a native Discord poll |
| `schedules` | `/schedule list`, `preview`, `pause`, `resume`, `delete` | member + `schedule-posts` | ✅ | Private. Manage scheduled posts; `schedule` autocompletes by name or ID |
| `feedback`| `/feedback message:`         | guest  | ✅    | Private. Sends a message (3–1000 characters) to Sentry as user feedback, with the sender's Discord name and ID. At most a few per person, then one every ten minutes. Says so if Sentry isn't set up |

### The Home Assistant commands

`/ha list` and `/ha status` only read. `/ha` has a floor of `friend` (the lowest any device can have, and a guest never passes), and each device's own floor is checked by the shared rule in `core/home-access.ts` (see `identity-and-access.md`), both when listing and when completing, so people see only what they may use. The commands don't need a capability: reading takes the tier floor alone.

- **Live, no cache:** every list and every status asks Home Assistant fresh, and only about the devices it will show. If Home Assistant can't be reached the reply says so plainly. With Home Assistant not set up, `/ha` says so, and there is nothing to autocomplete.
- **Everything from Home Assistant is untrusted text:** states, units and attributes are shown as code spans (so no formatting, links or mentions), with control characters removed and length limited. Device names come from the devices file, not from Home Assistant. Long readings are rounded to two decimals.
- **States that aren't readings** show as themselves, never as "off": `unavailable` (⚠️), `unknown` (❔), a device Home Assistant doesn't have (❔), and a kind's warning states such as a `jammed` lock (⚠️).
- **What a kind shows** is part of the kind (`attributes` and `warnStates` in `core/home-kinds/`): brightness for lights, the type and battery for sensors. A new kind says what's worth showing, and nothing else changes.
- **Size:** one embed field per kind, cut at the field limit with "…and N more."
- **Logging:** a refused status is logged with the real reason (`unknown-device` or `tier`) and the device name when it exists, never what was typed. Looking at a door is logged with who and which.

### Changing devices: `/ha set`

`/ha set device: state:` is the one place Pixel changes something in the real world, so it's strict and honest. `state` is the name of one of the kind's actions (`on`, `off`, `toggle` for lights and switches), and the kind's catalogue decides the service call: `on` on a light is `light.turn_on` on that entity, and nothing outside the catalogue can be sent. People can't pass a service name or any data.

- **Checked again at run time:** the device, the action and the person are checked against the devices file and the shared rule in `core/home-access.ts` when the command runs, whatever autocomplete offered. Anything not allowed gets the same generic `HOME_DENIED` answer as an unknown device, without calling Home Assistant. The log has the real reason (`unknown-device`, `tier`, `capability` or `action`) and never what was typed.
- **Autocomplete uses the same rule:** `device` offers only devices you may act on (narrowed by the state if you've chosen one), and `state` offers only what you may run on the chosen device, with what each does. With no device yet it offers the values that work somewhere. A suggestion is a convenience, never validation.
- **Check, act, confirm** (`features/home/control.ts`):
  1. Read the state fresh. If the device is already there, say so and send nothing. If it's `unavailable` or `unknown`, or a lock is already on its way (`unlocking`), send nothing.
  2. Make exactly one call. If Home Assistant can't be reached to read the state, nothing is sent. There are no retries and nothing is queued, so a late action can never happen. If the call itself times out or the connection drops, Pixel says it can't confirm and never resends.
  3. Watch for the end state every half second for eight seconds, and report what really happened: **done**, **still working** (a lock that is `unlocking`), **nothing changed**, **it didn't work** (`jammed`, or the device went unavailable), **can't confirm** (contact lost), or **Home Assistant refused**. A toggle counts as done when the state changed.
- **One at a time per device,** with a three-second cool-down after an action, so a double click sends one. A second run says someone is already changing it, or that it was only just changed.
- **Audit:** every action that ran logs `home.action` with who (from the dispatcher), the device, kind, action, state before and after (cut to 40 characters), outcome and duration, and leaves a Sentry breadcrumb. Refusals are logged as `home.action_denied`.
- **Replies are private,** and show Home Assistant's states as code spans. Home Assistant's own error text is never shown, only a fixed summary.
- **Doors** go through the same rule and the same check-act-confirm path, with three extras:
  - **Member-only.** The door kind has a tier floor of `member` (`minTier` on the kind), so the devices file can't open a door to friends: the loader refuses it. Acting still needs `ha-doors` or `ha-admin`.
  - **`/ha open door:`** is a shortcut that only takes doors: it runs `unlock` when the devices file allows it, and otherwise `open` (unlatch). `/ha set` still offers `open` for locks that can unlatch.
  - **An emergency switch.** `/admin doors off` (admins only) stops every door action from `/ha set` and `/ha open` at once, for everyone, and hides doors from autocomplete; `/admin doors on` brings them back. It's on by default and remembered across restarts in `data/home-switches.state` (`services/kind-switch.ts`). If that file exists but can't be read, doors start **off** until an admin switches them on. `/admin status` shows the state, and each switch is logged (`home.kind_switched`, with who) and left as a Sentry breadcrumb.
  - Every door action is logged like any other (`home.action` with who, door, action, before, after and outcome). There is no confirmation step, rate limit or public notice: logging is enough for now, and they can be added later if needed.

### Scheduled posts

`/schedule` posts messages and polls in a channel at set times, once or on a repeat. Discord has no scheduled messages for bots, so Pixel keeps the schedules and posts them itself.

- **Who:** members (and admins) holding the `schedule-posts` capability, granted with `/admin capabilities grant`. A schedule only keeps posting while whoever made it still has that access: when it's due, Pixel checks again and pauses it otherwise.
- **Where:** a text or announcement channel picked with the command (a new core `channel` option type). People can only schedule into channels where **they** can post, polls only where they can create polls, and `mentions` only where they can ping everyone (from the permissions Discord reports for the person in that channel). Pixel also checks its own permissions there before saving, and again when posting.
- **What:** a plain **message** (up to 2000 characters of markdown; pings are off unless `mentions` is on), or a native **Discord poll** (a question, 2–10 answers of up to 55 characters, open for 1 hour to 2 weeks, single or multiple choice). Discord counts the votes, shows them live and announces the result when it closes, so Pixel stores nothing about votes.
- **Forms:** the text, and the poll's question and answers (one per line), are typed in a **modal**, because slash options are one line. Commands declare these as `form` fields on string options. Discord can answer a slash command with a modal **or** a message, not both, so Pixel parses `when` (and the other slash options) **before** opening the modal (`Dispatcher.prepareForm` / `beforeForm`). A bad time is a private error and the modal never opens, so the body isn't typed against a timestamp that would be thrown away. The modal title is the interpreted time. The adapter keeps the typed options under a random token for 15 minutes for that one person, and runs the command when the form is submitted. The dispatcher checks everything again.
- **When:** Discord has no date picker for bots (no slash option type, no modal component, no Components v2 picker). Autocomplete would force picking from a short list of dates, so `when` is **free-form text**. Pixel parses it (`core/when.ts`: `wed 19:00`, `wed 1900`, `19u30`, `14 oct 19:00`, `tomorrow 9am`, and similar) into one future wall-clock moment in `PIXEL_TIMEZONE` and **confirms that time** in the private reply. Compact 24h (`1900`) and Dutch `19u` are times, not guessed by a date library. A day without a time is 19:00; a time without a day is the next clock hit. `repeat` is once, weekly, fortnightly (on one or more `days`, such as `wed sat` — autocomplete there is only a weekday vocabulary, not dates), monthly or every 2 months (on the start's day of the month, or the month's last day). Times stay on the wall clock through the summer/winter clock change (`core/recurrence.ts`).
- **Running:** the feature checks every 30 seconds (`features/schedules/runner.ts`). A due post goes out once; if Pixel was down, it still posts up to an hour late, skips anything later, and only the latest of several missed occurrences can go out. Every occurrence is recorded as handled whether it posted, was skipped or failed, and remembered in memory too, so nothing ever posts twice. Failures are logged and reported, never retried. A one-off is removed once it's handled.
- **Storage:** `data/schedules.yaml` (`services/schedules.ts`), written atomically, at most 50 schedules. Unlike the rest of `data/`, it's **not safe to delete**. If it's invalid, nothing is posted or changed (and it's never overwritten) until it's fixed; Pixel logs and reports why.
- **Posting** goes through the core `ChannelPosts`, which the Discord adapter plugs a poster into once it's connected, like the calendar. Every create, pause, resume, delete and post is logged with who and which schedule.

### The events list

`/events` reads the calendar and shows:
- **What's on now first** (🟢, with when it ends, or how long it's been going if it has no end time), then **upcoming events soonest first**, at most 5, plus "…and N more." if there are others.
- Each event has a linked title, when it is, how soon (`in 25m`, `in 3h 20m`, `in 2 days`), where, and 🔁 how often it repeats.
- **Times are plain text in one time zone** (`PIXEL_TIMEZONE`, default Europe/Amsterdam) with the zone shown, like `Sun 4 Oct, 20:00–23:00 CEST`. That reads the same on every platform and is unambiguous. The end time is shown only when it ends the same day. A per-reader local time, using Discord's timestamp markup, would need a small neutral mechanism in the core, and is worth adding if members are often in other time zones.
- Anything that has already ended is dropped, even if Discord still lists it as running.
- **Event titles, locations and repeat text are written by whoever made the event**, so they are escaped: they can't add formatting, fake a link, or inject a mention marker.
- The reply is public, like `/status`. It asks Discord live on every use, which takes about 200 ms, so it needs no "Checking…" box. If Discord is slow, the adapter defers the reply itself.
- If Discord can't be reached, the reply is a friendly error. It never shows an earlier list.

### The info topics

`/info` answers common questions from markdown files, one per topic, in `content/info/` (found through `PIXEL_CONTENT_DIR`):

```markdown
---
title: Becoming a member
summary: Member and Friend memberships, what they cost and how to join
order: 30        # optional; lower comes first, default 100
---
The text of the answer, in markdown…
```

- **The file name is the topic's ID**: lowercase letters, digits and single dashes, up to 32 characters (`membership.md`). It's what people pick in `/info topic:`.
- **Short answers that link to the canonical page.** Pixelbar's website is the source of truth for prices, rules and opening times, so each topic is a few lines plus a link. That way the bot doesn't become a second copy to keep up to date.
- **Everything is checked at startup**, and Pixel refuses to start if anything is wrong, listing every problem at once: a bad file name, a missing title or summary, unknown keys, empty text, text over 4,000 characters, or more than 25 topics (Discord's limit for choices). CI loads the real `content/info/` folder in a test, so a broken edit fails the PR.
- **`/info` with no topic lists them all** with their summaries. The topic choices are built from the files, so they're registered with Discord: **editing a topic's text goes live on the next deploy**, and **adding, removing or renaming a topic also needs the commands re-registered** (`just register`; the deploy pipeline will do it, #10).
- **Content is baked into the Docker image** (`COPY content ./content`), so changing it means a deploy.
- **The content is public.** This repository is public, so never put secrets (wifi passwords, door codes) or personal data in `content/`. That's why there are no member-only topics yet.
- The text is shown as written, since it comes from this reviewed repository. (Text written by other people, like event titles, is always escaped.)
- **Placeholders:** topic text can use `{{name}}`, filled in when the topics are loaded, so the same reviewed text works in every environment. Today there's one, `{{announcements-channel}}`, which becomes a clickable channel link in Discord when `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` is set, and the plain words "the announcements channel" otherwise. An unknown placeholder or a stray `{{` stops startup (and fails CI), so a typo can't show up in a reply. The length limit applies to the text after filling in. Values are Discord-flavoured for now, because Discord is the only platform.
- **Opening hours** come from the board: "Normally Wednesday evening until late, check the announcements channel and vote in the weekly poll so someone knows you're interested!" Pixelbar's own pages disagree about the times, so `/info` doesn't state fixed hours.

### Announcing changes

When the space opens or closes, the `status` feature announces it through the announcer (`features/status/announce.ts`):
- **Never on startup.** The status service only reports changes it saw, so starting up, or a change while Pixel was down, announces nothing.
- **Only once it holds.** A change is announced once the new state has been seen on 2 polls in a row (`READINGS_TO_CONFIRM`), so about 30–60 s after it happens. If it flips back before that, nothing is posted, so flicking the switch doesn't flood the channel.
- **If SpaceAPI is unreachable while confirming,** Pixel keeps trying each interval for up to about 5 minutes, then gives up rather than guessing.
- **At most once.** A change is never announced twice, even if every publisher failed.
- **At startup, stale posts are corrected, not re-announced.** Each publisher gets the current state (`Publisher.reconcile`) once SpaceAPI answers. The live style uses it to turn a leftover "open" post into "closed" (without a closing time, since Pixel didn't see it) when the space closed while Pixel was down. It never posts anything new.

`/schedule` is member-only and also needs the `schedule-posts` capability. Home Assistant already uses the same pattern (`/ha open` is member-only plus a capability).

## Observability

- **Sentry** (`@sentry/node`) is initialised in `src/instrument.ts`, which is loaded with `--import` before the app. If no DSN is set, it does nothing.
  - Each command scope carries the tags `command`, `feature`, `platform` and `tier`. The Sentry user is the stable platform ID (`discord:<id>`), so a user's issues can be traced over time, with their Discord handle as `username` and display name as `name` so people can recognise them.
  - **The Discord ID is on every error that can be traced to someone.** The dispatcher runs each command (and each autocomplete) inside `ErrorReporter.withContext`, which sets the user and tags on Sentry's isolation scope for the whole run, starts a `command` span, and counts a `pixel.command` metric. So an error reported anywhere beneath it, however deep (Home Assistant unreachable, the role mirror, a background report) carries who asked, as do breadcrumbs, traces and Sentry Logs from that moment. Two commands at once stay separate. A failure handling an interaction in the Discord adapter names the person too (`captureBackground(error, source, actor)`). Errors with no person behind them (SpaceAPI polling, startup, an uncaught exception outside a command) have no user. `dataCollection.userInfo: false` doesn't affect this: it only stops Sentry inferring IP addresses and the like. A test with a real Sentry client checks the ID is on the sent events.
  - **Tracing** is on (`tracesSampleRate` from `SENTRY_TRACES_SAMPLE_RATE`, default `1`). Discord commands are not HTTP, so the command span is started in `withContext`. Outgoing HTTP (SpaceAPI, Home Assistant, Discord's API) is traced by the default HTTP and fetch integrations. Incoming `/healthz` and `/readyz` probes are ignored, and they are **not** counted as request sessions: Pixel's session is the process (`processSessionIntegration`, a default), so crash-free rate tracks the bot staying up, not Azure poking it.
  - **Runtime metrics** (`nodeRuntimeMetricsIntegration`) send CPU, memory, event-loop delay and uptime every 30 seconds.
  - **Profiling** (`@sentry/profiling-node`) attaches a CPU profile to sampled traces (`profileLifecycle: "trace"`). `profileSessionSampleRate` comes from `SENTRY_PROFILE_SESSION_SAMPLE_RATE` (default `1`). The native integration is left out when the rate is `0`.
  - Errors are not sampled (`sampleRate` is `1`).
  - All `dataCollection` categories are off, including stack-frame local variables, and `includeServerName` is false. `beforeSend` and `beforeBreadcrumb` scrub anything that looks like a bot token.
  - Releases are tagged with the git SHA (`PIXEL_VERSION`). Source maps upload from CD / `just sentry-release`. The CD job **fails closed** if `SENTRY_ORG`, `SENTRY_PROJECT`, or `SENTRY_AUTH_TOKEN` is missing.
  - `environment` is `local`, `dev` or `prod`.
- **Logs:** everything is logged through the one pino logger (`observability/logger.ts`, no `console`), and each line goes to **three** places:
  - **The console:** JSON, or readable with pino-pretty when `PIXEL_ENV=local`.
  - **A rotating file** of JSON lines in `PIXEL_LOG_DIR` (default `data/logs`, empty turns it off): `pixel.<date>.<n>.log` with `current.log` pointing at the live one, a new file each day or at 20 MB, about two weeks kept (14 besides the live one, including files left by earlier runs), readable only by the user running Pixel. It's written by the `pino-roll` transport in a worker thread. If the directory can't be written, Pixel carries on with the console and Sentry and logs a warning (`log.file_unavailable`), so a read-only disk never stops the bot.
  - **Sentry Logs:** Sentry's pino integration (set up in `observability/sentry-options.ts`) sends `info` and above as Sentry Logs, whatever `LOG_LEVEL` is (debug stays in the console and the file), with each line's fields as attributes. They aren't turned into error events: real failures still reach Sentry as events through the `ErrorReporter`. Nothing is sent when no DSN is set.
  - **Secrets:** pino redacts `token` and authorization headers by name, and every line written (console and file) has anything shaped like a bot or Home Assistant token masked on the way out. Sentry's copy is scrubbed again in `beforeSendLog`.
  - **Failures nobody caught:** an unhandled promise rejection and an uncaught exception are logged too (`process.unhandled_rejection`, `process.uncaught_exception`), so they reach the file and Sentry as well as the console. Neither changes whether the process exits: a rejection is logged and the bot carries on (like Sentry's default), and an exception still ends the process.
- **Heartbeat** (`observability/heartbeat.ts`): a dead bot can't report its own death, and Discord doesn't health-check bots, so Pixel checks in with a **Sentry cron monitor** (`pixel-<env>`, one per environment) every `PIXEL_HEARTBEAT_MINUTES` (default 5), and when Discord connects. A check-in is `ok` while the Discord gateway is connected and `error` while the process is up but disconnected. Sentry creates and updates the monitor from the first check-in (interval schedule, five minutes' margin so a deploy or restart doesn't count, one missed or failed check-in opens an issue, one good one resolves it). So a crash, a hang, a lost Discord connection or the host going down becomes a Sentry issue within about ten minutes. Off without a DSN or with `PIXEL_HEARTBEAT_MINUTES=0`. A failing check-in is logged and never affects the bot.
- **Health:** a small HTTP server exposes `/healthz` (process alive) and `/readyz` (Discord gateway connected).

## Configuration

Environment variables are validated by `config.ts` (zod). Nothing else reads `process.env`. Access lists live in YAML files (see the identity doc).

| Variable                      | Secret | Notes                                          |
| ----------------------------- | ------ | ---------------------------------------------- |
| `PIXEL_ENV`                   |        | `local`, `dev` or `prod` (default `local`)     |
| `PIXEL_RUNTIME`               |        | `local` or `cloud` (default `local`). Azure Container Apps sets `cloud`. `/admin status` and the online post show it as **Where** |
| `PIXEL_VERSION`               |        | Set by the image build (git SHA); the Sentry release |
| `PIXEL_ADMINS_FILE`           |        | Default `config/admins.yaml`                   |
| `PIXEL_MEMBERS_FILE`          |        | Default `config/members.yaml`. Pixel writes to it (and to `<file>.bak` and a temp file in the same folder), so the folder must be writable |
| `PIXEL_DATA_DIR`              |        | Default `data`. Runtime state: `schedules.yaml` (must persist), `home-switches.state`, `space.state`, `announcements.state`. Gitignored |
| `PIXEL_TIMEZONE`              |        | Default `Europe/Amsterdam`. The time zone event times are shown in |
| `PIXEL_CONTENT_DIR`           |        | Default `content`. The reviewed content Pixel reads (`info/*.md` for `/info`). Read-only |
| `DISCORD_TOKEN`               | yes    |                                                |
| `DISCORD_APP_ID`              |        |                                                |
| `DISCORD_GUILD_ID`            |        | The only guild Pixel serves                    |
| `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` |    | Optional. The channel where announcements and the weekly poll are posted. `/info` points people at it. (Not the space-status posts below) |
| `DISCORD_ANNOUNCE_LIVE_CHANNEL_ID` |   | Optional. Live style: one post per opening, edited to "closed" |
| `DISCORD_ANNOUNCE_BOT_CHANNEL_ID` | | Optional. Where Pixel says it's online or offline. Defaults to `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` |
| `PIXEL_GIT_SHA`, `PIXEL_GIT_BRANCH` | | Set by CI and the image build. The commit and branch shown in the online post. From a checkout, Pixel asks git instead |
| `DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID` | | Optional. Timeline style: a new post for every open and close |
| `DISCORD_ROLE_MEMBER`         |        | Optional. A Discord role name or ID that the `member` level is mirrored to. Unset means not mirrored |
| `DISCORD_ROLE_FRIEND`         |        | Optional. A Discord role name or ID that the `friend` level is mirrored to. Unset means not mirrored |
| `HOME_ASSISTANT_URL`          |        | Optional, with the token. Where Pixel reaches Home Assistant (http or https). On Azure prefer the Tailscale sidecar address; a Nabu Casa URL still works |
| `HOME_ASSISTANT_TOKEN`        |        | Optional, with the URL. A long-lived access token from a **non-admin** Home Assistant user. A secret |
| `PIXEL_HOME_ASSISTANT_DIR`    |        | Default `config/home-assistant`. Holds `devices.yaml`, the allow-list of devices. Required when Home Assistant is set up |
| `PIXEL_HOME_SYNC_MINUTES`     |        | Default `60`. How often the inventory (`inventory.yaml`, everything Home Assistant has: known, not usable) is refreshed. 0 means only at startup and on `/admin reload` |
| `SENTRY_DSN`                  | yes    | Optional. Operator-only (not in `config.ts`): `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` for `just sentry-release` / CD |
| `SENTRY_TRACES_SAMPLE_RATE`   |        | Default `1`. How many traces Sentry keeps (`0`–`1`). Needs `SENTRY_DSN`. Errors are always kept. |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` |  | Default `1`. How many of those traces get a CPU profile (`0`–`1`). Needs `SENTRY_DSN`. |
| `LOG_LEVEL`                   |        | Default `info`                                 |
| `PIXEL_HEARTBEAT_MINUTES`     |        | Default `5`. How often Pixel checks in with its Sentry cron monitor (`pixel-<env>`), so Sentry alerts when it goes quiet. 0 turns it off. Needs `SENTRY_DSN` |
| `PIXEL_LOG_DIR`               |        | Default `data/logs`. A rotating JSON log file is written here (about two weeks, readable only by the owner). Empty turns the file off; the console and Sentry Logs still get every line |
| `HEALTH_PORT`                 |        | Default `8080`                                 |
| `SPACEAPI_URL`                |        | Default `https://spaceapi.pixelbar.nl/`; http(s) only |

If neither announcement channel is set, nothing is announced. Both can be the same channel.

Per-platform settings for later adapters (Telegram tokens, the Mastodon instance and account) will come from configuration when those adapters are built. No account is hard-coded.

## Local development

Every task goes through the [`justfile`](../justfile). Run `just` to list the recipes. `just dev` runs the bot with `tsx watch`, which also restarts it when `config/*.yaml` changes. `just check` runs the same lint, type-check and test steps that CI will run.

## Deployment

How the hosted pieces fit together (diagrams of Azure, GitHub, Discord, Home Assistant, Sentry): [`infra.md`](infra.md). Terraform layout: [`infra/`](../infra/).

There is **no database**. Access, schedules and (planned) account linking are files. Do not add Postgres because an old issue said so (#15, #18).

- **Platform:** Azure Container Apps, **exactly one replica**, no ingress, with a managed identity. A Discord gateway connection needs an always-on process. Two replicas would both connect and answer every command twice. Max replicas = 1 (not a variable). Deploys **stop the old instance before starting the new one** (#11). This stack only pins min=max=1 and `revision_mode = Single`. A database lock is not a plan; there is no database.
- **Images:** local `just deploy-dev` pushes `ghcr.io/pixelbar/pixel:<sha>` (or a `dev-dirty-*` tag) and moving `:dev` for Azure `dev`. Merges to `main` push the SHA and moving `:main` via [`.github/workflows/cd.yml`](../.github/workflows/cd.yml). Builds are **linux/amd64** (Azure Container Apps); the Mini is arm64, so `just deploy-dev` cross-builds. The images contain no secrets and no access lists. The GHCR package is **public** so Container Apps can pull without a registry password. If it is ever private again, `dev` can set `container_registry_server` / `container_registry_username` and Key Vault `ghcr-pull-token`. The running app pins an explicit tag, never `latest` alone. CI still builds with `push: false` as a smoke check.
- **Secrets:** Key Vault. Discord token, Home Assistant token, Sentry DSN, Tailscale auth key, `admins.yaml`, and optional `ghcr-pull-token` (private GHCR only) reach the container as secrets, never as image layers or Terraform state. Terraform may write them at apply from ephemeral write-only inputs (`write_secrets`); otherwise set them with `az` or the portal. Prod must not receive the Mini local / Pixel Dev token (that bot lives in `pixel-dev-kv`).
- **Access files:** `admins.yaml` is a **read-only** Key Vault secret mount. `members.yaml` is rewritten by admin commands, so it **cannot** be a read-only secret mount. It lives on a **writable Azure Files volume with snapshots**. `config/home-assistant/` is on the same volume: `devices.yaml` is a human allow-list; `inventory.yaml` is rewritten by Pixel. There is no block-list (#6).
- **Runtime files:** the Azure Files share is mounted at `/app/persist` as uid 1000 (`node`), covering `members.yaml`, `home-assistant/`, and `PIXEL_DATA_DIR` (`schedules.yaml` must persist; `home-switches.state` lost → doors start **off**; `space.state` and `announcements.state` only cost details). A container's own filesystem is thrown away on every deploy.
- **Environments (temporary routing):** `dev` (Pixel Dev bot, test guild) is `infra/envs/dev`. `prod` (Pixel bot, Pixelbar guild) is #12. Separate bots, tokens and vaults. **`just deploy-dev`** (a local build) rolls Azure `dev` (one replica, then `just register`, then Sentry release). **Merges to `main`** publish GHCR only. CI does not deploy pull requests, and **does not deploy prod** until #12. This overrides the earlier `main` → `dev` plan until [ADR 0010](adr/0010-ghcr-cd.md) is reverted. Fail closed: never copy the Mini / Pixel Dev Discord token into prod.
- **Terraform layout:** `infra/bootstrap` (state storage, GitHub OIDC, applied) then `infra/modules/pixel` and `infra/envs/dev` (#9). Secret values never go into Terraform state; apply can take them as ephemeral write-only inputs. Subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`, West Europe. See [ADR 0008](adr/0008-terraform-bootstrap.md) and [ADR 0009](adr/0009-container-apps-dev.md). CD does **not** apply Terraform; it updates the Container App image.
- **Home Assistant from Azure:** Tailscale sidecar into the space network is the preferred path (`tailscale_enabled`); `HOME_ASSISTANT_URL` can still be a Nabu Casa URL. Both URL and token or neither. Sidecar is userspace (no TUN). LAN MagicDNS through it is remaining work for #43.
- **Cost (rough):** always-on `dev` is about €40–55/month West Europe without Tailscale, plus about €15 with the sidecar. Not a quote.
- **CI (built):** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every PR and on pushes to `main`. It runs `just check` (lint, type-check, tests with coverage thresholds) and `just build`, uploads the coverage report, and checks that the Docker image builds. [`terraform.yml`](../.github/workflows/terraform.yml) runs `just tf-validate` (bootstrap and `envs/dev`) only when `infra/`, that workflow, or the `justfile` change, then `terraform plan` on `envs/dev` via GitHub Environment `dev` OIDC. Missing `ARM_*` **fails closed**. No apply on merge. Actions are pinned to commit SHAs.
- **CD (built, temporary routing):** `just deploy-dev` for Azure `dev` (local GHCR push + `az` + `just register` + Sentry release). [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) on `main` only: publish with `GITHUB_TOKEN` (`packages: write` on that job) and upload Sentry source maps (fails closed if org/token are missing). **No Azure login and no `pixel-prod` update** until #12. See [ADR 0010](adr/0010-ghcr-cd.md).

## Adding a platform (later)

- **Interactive** (for example Telegram): create `src/adapters/telegram/`. It builds a `PlatformActor`, calls the dispatcher and renders `Reply`. Telegram users get tiers only after account linking, which writes a second id onto the existing `members.yaml` entry (see the identity doc). No database.
- **Outbound only** (for example Mastodon): implement `Publisher`, configure the instance and account through environment variables, and register it with the announcer. Features do not change. When there are several publishers, add per-kind routing as config.

## Open questions

- Who has Owner (or Contributor) on the Pixel Azure subscription, besides the person applying bootstrap?
- Which Sentry org? (Needed for Sentry releases from CD / `just sentry-release`. Set repository variables `SENTRY_ORG` and `SENTRY_PROJECT`, and secret `SENTRY_AUTH_TOKEN`. Image publish does not use them; the CD Sentry job fails closed if they are missing.)
- Where should private change history for `admins.yaml` live (a private repo, or Key Vault versions)? `members.yaml` is bot-managed; backups are volume snapshots, not Key Vault secret versions.
- Which channels should the live and timeline announcements go to in the real server?

## Decision log

Record significant decisions as short ADRs in `docs/adr/NNNN-title.md`.

| #    | Decision                                                              | Status   |
| ---- | --------------------------------------------------------------------- | -------- |
| 0001 | TypeScript, ports-and-adapters core, interactive vs publisher adapters | proposed |
| 0002 | Phase 1 tiers from gitignored YAML files; admins in a separate file; fail closed | proposed |
| 0003 | No database: access, schedules and planned linking are files          | accepted |
| 0004 | Azure Container Apps, single replica; GHCR; dev + prod                | proposed |
| 0005 | Sentry for errors (no PII), pino to stdout, a rotating file and Sentry Logs | proposed |
| 0008 | Terraform bootstrap: remote state (Azure AD, no shared keys) and GitHub OIDC (UAMI per env) | accepted |
| 0009 | Container Apps module + `dev`: one replica, required Azure Files volume, Key Vault, optional Tailscale sidecar | accepted |
| 0010 | Temporary GHCR CD: local `just deploy-dev` → Azure `dev`; `main` publishes GHCR only (prod CD off until #12) | accepted |
