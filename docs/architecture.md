# Pixel architecture

> Status: **draft**. Nothing is built yet. Identity and access control have their own document: [`identity-and-access.md`](identity-and-access.md).

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
| SpaceAPI status, Discord events, info, help, whoami         | A database (none is needed until linking or grants) |
| Sentry, pino, `just`                                        | Terraform and CI/CD (designed below, built later)   |

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
- **Guild allow-list:** interactions from any guild other than `DISCORD_GUILD_ID` are refused, and the bot leaves other guilds. There are no DMs in phase 1, because guild commands aren't available in DMs.
- **Autocomplete:** a string or integer option can have a `suggest` function (never together with fixed `choices`). It runs while someone types and returns up to 25 `{ name, value }` suggestions from live data, and it can see the options already filled in, so the actions offered can depend on the device chosen. `Dispatcher.suggest` runs it through the **same access gates as the command**, so people who can't run a command get an empty list (logged as `command.suggest_denied`), and it has its own, more generous rate limit so typing can't use up the budget for commands. A slow (over 2.5 s, Discord's limit is 3) or failing function gives an empty list. What was typed is never logged. **Suggestions are not validation:** Discord doesn't check that a submitted value came from them, so the command validates what it receives as usual.
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
- **Calendar source:** once connected, the adapter plugs the server's Discord scheduled events into the core `Calendar`. It reads them over REST on every call, needing no extra intents or permissions. (discord.js only skips the request when asked for one event by ID, which this never does.) Voice and stage channel names come from discord.js's channel cache, which Discord keeps current through gateway updates, so a renamed channel is right immediately. `calendar-map.ts` (pure, fully tested) maps each Discord event to a neutral `CalendarEvent`: external events use their location text, voice and stage events use the channel's name, finished and cancelled events are dropped, and recurrence rules become plain words ("weekly on Tuesday"). Discord returns a recurring event once, showing its next occurrence.

## Home Assistant (a client, not an adapter)

Pixel can read and control a Home Assistant (HA) instance: lights, switches, doors. Unlike Discord this is not a place where commands come from. Pixel is the client, and features reach HA only through the core `Home` (`core/home.ts`), the same way they use the calendar. The adapter in `adapters/home-assistant/` is the **only** place that imports the official `home-assistant-js-websocket` library, and it plugs a backend into `Home` at startup.

- **Connection:** `HOME_ASSISTANT_URL` (for example the Nabu Casa cloud address) and `HOME_ASSISTANT_TOKEN`, a long-lived token. Both unset means off, and only one set stops startup. It connects in the background and reconnects forever, so a slow or absent HA never holds up the bot, and it doesn't count towards `/healthz`: HA being down shouldn't restart Pixel.
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
| `accessConfig`   | Admin and member lists               | Loads and validates the two YAML files at startup (`ConfigTierSource`) |
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
| `admin`   | `/admin capabilities grant\|revoke user: capability: [reason:]` | admin | ✅ | Gives or takes a named permission. Picked from the registry in `features/capabilities.ts`, audited, refused for guests and bots. Says so when nothing would change |
| `admin`   | `/admin capabilities list [user:]` | admin | ✅ | Private. The registered capabilities with holder counts, or one person's |
| `status`  | `/status`                    | guest  | ✅    | Public. A "Checking…" box, then a live answer: open (green) or closed (red), and how long (if Pixel saw the change) |
| `status`  | background: announce changes | n/a    | ✅    | Posts to the live and/or timeline channels (see below) |
| `events`  | `/events`                    | guest  | ✅    | Public. What's on now, then the next events (5 at most), with when, how soon, where and how often it repeats |
| `info`    | `/info [topic]`              | guest  | ✅    | Public. Short answers about Pixelbar from `content/info/`, with no topic it lists them |
| `home`    | `/ha list`                   | friend | ✅    | Private. The devices you may use (by each device's tier floor), grouped by kind, with their live state. Unavailable and unknown show as themselves. Says so when nothing is available to you, or when Home Assistant isn't set up |
| `home`    | `/ha status device:`         | friend | ✅    | Private. One device's live state, when it last changed and a few details for its kind (brightness, battery, the unit of a reading). `device` autocompletes, offering only what you may see. An unknown device and one you may not see get the same generic answer. Looking at a door is logged |
| `home`    | `/ha set device: state:`     | friend | ✅    | Private. Changes a device, such as `on` or `off` for a light. Needs the device's tier floor and `ha-admin` or the kind's capability, and an action the devices file allows. Both options autocomplete: `state` offers what that device allows, and what you may run. Reports what really happened. Doors are switched off for now |
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
- **Doors are off for now.** Even for someone with `ha-doors` or `ha-admin`, and even if a door's actions are listed in the devices file, `/ha set` refuses doors ("isn't switched on yet") and never offers them in autocomplete. They come on with the door safeguards (#29: a public notice, a confirmation, conditions and an emergency switch). Until then lights and switches are the only kinds that can be changed.

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

There are no member-only features yet. The first one will be the real test of the access layer, but the plumbing and tests come first.

## Observability

- **Sentry** (`@sentry/node`) is initialised in `src/instrument.ts`, which is loaded with `--import` before the app. If no DSN is set, it does nothing.
  - Each command scope carries the tags `command`, `feature`, `platform` and `tier`. The Sentry user is the stable platform ID (`discord:<id>`), so a user's issues can be traced over time, with their Discord handle as `username` and display name as `name` so people can recognise them.
  - All `dataCollection` categories are off, including stack-frame local variables, and `includeServerName` is false. `beforeSend` and `beforeBreadcrumb` scrub anything that looks like a bot token.
  - Releases are tagged with the git SHA, and source maps are uploaded from CI later.
  - `environment` is `local`, `dev` or `prod`.
- **Logs:** pino writes JSON to stdout. Locally, pino-pretty makes it readable.
- **Health:** a small HTTP server exposes `/healthz` (process alive) and `/readyz` (Discord gateway connected).

## Configuration

Environment variables are validated by `config.ts` (zod). Nothing else reads `process.env`. Access lists live in YAML files (see the identity doc).

| Variable                      | Secret | Notes                                          |
| ----------------------------- | ------ | ---------------------------------------------- |
| `PIXEL_ENV`                   |        | `local`, `dev` or `prod` (default `local`)     |
| `PIXEL_VERSION`               |        | Set by the image build (git SHA); the Sentry release |
| `PIXEL_ADMINS_FILE`           |        | Default `config/admins.yaml`                   |
| `PIXEL_MEMBERS_FILE`          |        | Default `config/members.yaml`. Pixel writes to it (and to `<file>.bak` and a temp file in the same folder), so the folder must be writable |
| `PIXEL_DATA_DIR`              |        | Default `data`. Runtime state (`space.state`, `announcements.state`); gitignored |
| `PIXEL_TIMEZONE`              |        | Default `Europe/Amsterdam`. The time zone event times are shown in |
| `PIXEL_CONTENT_DIR`           |        | Default `content`. The reviewed content Pixel reads (`info/*.md` for `/info`). Read-only |
| `DISCORD_TOKEN`               | yes    |                                                |
| `DISCORD_APP_ID`              |        |                                                |
| `DISCORD_GUILD_ID`            |        | The only guild Pixel serves                    |
| `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` |    | Optional. The channel where announcements and the weekly poll are posted. `/info` points people at it. (Not the space-status posts below) |
| `DISCORD_ANNOUNCE_LIVE_CHANNEL_ID` |   | Optional. Live style: one post per opening, edited to "closed" |
| `DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID` | | Optional. Timeline style: a new post for every open and close |
| `DISCORD_ROLE_MEMBER`         |        | Optional. A Discord role name or ID that the `member` level is mirrored to. Unset means not mirrored |
| `DISCORD_ROLE_FRIEND`         |        | Optional. A Discord role name or ID that the `friend` level is mirrored to. Unset means not mirrored |
| `HOME_ASSISTANT_URL`          |        | Optional, with the token. The address Pixel reaches Home Assistant at, such as the Nabu Casa cloud URL (http or https) |
| `HOME_ASSISTANT_TOKEN`        |        | Optional, with the URL. A long-lived access token from a **non-admin** Home Assistant user. A secret |
| `PIXEL_HOME_ASSISTANT_DIR`    |        | Default `config/home-assistant`. Holds `devices.yaml`, the allow-list of devices. Required when Home Assistant is set up |
| `PIXEL_HOME_SYNC_MINUTES`     |        | Default `60`. How often the inventory (`inventory.yaml`, everything Home Assistant has: known, not usable) is refreshed. 0 means only at startup and on `/admin reload` |
| `SENTRY_DSN`                  | yes    | Optional                                       |
| `LOG_LEVEL`                   |        | Default `info`                                 |
| `HEALTH_PORT`                 |        | Default `8080`                                 |
| `SPACEAPI_URL`                |        | Default `https://spaceapi.pixelbar.nl/`; http(s) only |

If neither announcement channel is set, nothing is announced. Both can be the same channel.

Per-platform settings for later adapters (Telegram tokens, the Mastodon instance and account) will come from configuration when those adapters are built. No account is hard-coded.

## Local development

Every task goes through the [`justfile`](../justfile). Run `just` to list the recipes. `just dev` runs the bot with `tsx watch`, which also restarts it when `config/*.yaml` changes. `just check` runs the same lint, type-check and test steps that CI will run.

## Deployment (designed, not built in phase 1)

- **Platform:** Azure Container Apps, **exactly one replica**, no ingress, with a managed identity. A Discord gateway connection needs an always-on process. Two replicas would both connect and answer every command twice. That means max replicas = 1, and deploys should use a stop-then-start strategy, or a lock once a database exists.
- **Images:** built by GitHub Actions and pushed to `ghcr.io/pixelbar/pixel:<sha>`. The images contain no secrets and no access lists.
- **Secrets and access files:** Key Vault. The two YAML files are stored as secrets and mounted into the container as files.
- **Runtime state:** the container writes `space.state` and `announcements.state` to `/app/data`. A container's own filesystem is thrown away on every deploy, so without a mounted volume (for example Azure Files) the "open for 2h" detail resets after each deploy, and the live style loses its remembered post and relies on searching the channel's recent messages instead. Pixel works fine either way, so a volume is optional (#9).
- **Environments:** `dev` (Pixel Dev bot, test guild) and `prod` (Pixel bot, Pixelbar guild), with separate bots, tokens and vaults. Merges to `main` deploy to dev. Prod needs manual approval through a GitHub Environment.
- **Terraform layout:** `infra/bootstrap` (state storage, GitHub OIDC), `infra/modules/pixel`, and `infra/envs/{dev,prod}`. Secret values never go into Terraform variables or state.
- **CI (built):** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every PR and on pushes to `main`. It runs `just check` (lint, type-check, tests with coverage thresholds) and `just build`, uploads the coverage report, and checks that the Docker image builds. Actions are pinned to commit SHAs, and the workflow can only read the repo.
- **CD (planned):** on `main`, push the image to GHCR, create a Sentry release with source maps, and deploy to dev. Prod deploys need approval.

## Adding a platform (later)

- **Interactive** (for example Telegram): create `src/adapters/telegram/`. It builds a `PlatformActor`, calls the dispatcher and renders `Reply`. Telegram users get tiers only after account linking, which brings in Postgres (see the identity doc).
- **Outbound only** (for example Mastodon): implement `Publisher`, configure the instance and account through environment variables, and register it with the announcer. Features do not change. When there are several publishers, add per-kind routing as config.

## Open questions

- Where should private change history for `admins.yaml` and `members.yaml` live (a private repo, or Key Vault versions)?
- Which Azure subscription and which Sentry org? (Needed once infrastructure work starts.)
- Which channels should the live and timeline announcements go to in the real server?

## Decision log

Record significant decisions as short ADRs in `docs/adr/NNNN-title.md`.

| #    | Decision                                                              | Status   |
| ---- | --------------------------------------------------------------------- | -------- |
| 0001 | TypeScript, ports-and-adapters core, interactive vs publisher adapters | proposed |
| 0002 | Phase 1 tiers from gitignored YAML files; admins in a separate file; fail closed | proposed |
| 0003 | No database until account linking or grants need one                  | proposed |
| 0004 | Azure Container Apps, single replica; GHCR; dev + prod                | proposed |
| 0005 | Sentry for errors (no PII), pino to stdout for logs                   | proposed |
