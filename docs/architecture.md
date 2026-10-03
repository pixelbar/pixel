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
| Core: commands, access, dispatcher, registry, announcer, scheduler | Telegram, Mastodon, other adapters           |
| Discord adapter (interactive + publisher + calendar)        | Account linking across platforms                    |
| Tiers from `config/admins.yaml` and `config/members.yaml`   | Discord role sync                                   |
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
   │  Publisher (announcement channel)        │   └───────────────────┘
   │  CalendarPort (guild scheduled events)   │
   └───────┬──────────────────────────▲───────┘
           │                          │ Announcement
           ▼                          │
   ┌──────────────────────────────────┴───────┐
   │ core                                     │
   │  identity (TierSources) → dispatcher     │
   │  (rate limit → authorize → handler)      │
   │  registry · announcer · scheduler        │
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
   │             knowledge                    │
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
  options?: CommandOption[];     // string | integer | boolean, with optional choices
  private?: boolean;             // default reply visibility
  placeholder?: Reply;           // shown at once (e.g. "Checking…"), then replaced by the result
  handler: (ctx: CommandContext) => Promise<Reply>;
};

type CommandContext = {
  args: Record<string, string | number | boolean | undefined>;   // validated against options
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

// core/announcer.ts
type Announcement = {
  kind: string;                  // "space.status", …
  text: string;                  // plain text, short (fits any platform)
  url?: string;
  embed?: Embed;
};
type Publisher = { id: string; publish(a: Announcement): Promise<void> };

// core/feature.ts
type Feature = {
  name: string;
  commands?: CommandDefinition[];
  jobs?: ScheduledJob[];         // { name, everyMs, run(ctx) }
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
- **Announcer** sends each announcement kind to the publishers configured for it (`ANNOUNCE_ROUTES`). One publisher failing doesn't block the others, and failures go to Sentry. Phase 1 has one publisher: a Discord channel.
- **Scheduler** runs simple interval jobs in the process, for example polling SpaceAPI. Jobs report to Sentry Cron Monitors.
- **Rate limiter** keeps an in-memory token bucket for each user. That is enough because there is a single replica.
- **Errors:** `UserFacingError` is shown to the user and not reported. Anything else is reported to Sentry, and the user gets a generic reply. Errors outside commands, from background work or platform clients, go through `ErrorReporter.captureBackground` and are tagged with their source.

## Discord adapter

- **discord.js v14, slash commands only.** Intents: `Guilds` and `GuildScheduledEvents`, neither of which is privileged. No `MessageContent`.
- **Guild allow-list:** interactions from any guild other than `DISCORD_GUILD_ID` are refused, and the bot leaves other guilds. There are no DMs in phase 1, because guild commands aren't available in DMs.
- **Mapping:** `CommandDefinition.options` become Discord slash command options. `Reply` becomes the message content plus embeds, truncated to Discord's limits. `private` becomes the ephemeral flag. **Mentions are always disabled** (`allowedMentions: { parse: [] }`), so no reply can ping `@everyone`.
- **Acknowledging within 3 seconds:** Discord requires a response within 3 s. Pixel acknowledges with whichever comes first:
  - the command's placeholder, which is posted straight away
  - `deferReply()`, if the handler is still running after 1.5 s (this uses the command's default visibility)
  - the final reply
- **Placeholders and deferrals are edited into the result.** Edits always set both content and embeds, because Discord keeps any field an edit leaves out.
- **Visibility can't change after the first response.** If the first response was public but the result is private, Pixel deletes it and sends the result as an ephemeral follow-up. A private result is never shown publicly.
- **Accents:** `Embed.accent` sets the colour of the embed's side bar.
- **Registration:** `just register` runs a script that builds the command list from the registry and sends it with a REST PUT to the guild. Commands are registered to the guild only, because Pixel serves just one, so updates show up instantly.
- **Publisher:** posts announcements to `DISCORD_ANNOUNCE_CHANNEL_ID`.
- **CalendarPort:** lists the guild's scheduled events through REST, with a short cache.

## Services and ports

| Service / port   | Purpose                              | Implementation                                                    |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `accessConfig`   | Admin and member lists               | Loads and validates the two YAML files at startup (`ConfigTierSource`) |
| `spaceStatus`    | Is the space open?                   | `services/space-status.ts`. `checkNow()` asks `SPACEAPI_URL` (SpaceAPI v0.13) live, with a 5 s timeout, a size cap and validation. Overlapping checks share one request. Background polling every 60 s tracks when the state changed, and `onChange` fires on open↔closed flips. The last state and its time are saved to `space.state` and restored on startup (below). After 5 consecutive failures it reports once, and it logs when SpaceAPI recovers |
| `CalendarPort`   | Upcoming events                      | Implemented by the Discord adapter                                |
| `knowledge`      | Info topics                          | Markdown files in `content/`                                      |

Pixelbar's SpaceAPI response has `state.open` but no `lastchange`, so Pixel records when it saw each change and remembers it in `space.state` (YAML, in `PIXEL_DATA_DIR`, default `data/`). It's written only when the state changes, atomically (temp file and rename).

On startup the saved state is trusted only once a live reading agrees with it:
- **Same state:** the saved "since" is kept, so a restart doesn't lose it.
- **Different state:** the space changed while Pixel was down, so when is unknowable. "Since" is cleared and **no change event fires**, so a restart never announces a stale change (see #3).
- **Missing, malformed or unreadable file:** Pixel starts fresh and logs a warning. Unlike the access lists this is not fail-closed: the file only affects the "open for 2h" text, so it must never stop the bot. A saved time in the future (clock change or hand-edit) is ignored.
- **Can't write:** checks carry on, and the failure is logged, and reported to Sentry once.

The [spaceapi.io directory](https://api.spaceapi.io/openapi.json) was considered as a source of "last changed", but its `lastSeen` is when the directory last *reached* the endpoint (about every minute), not when the state changed. It also keeps no history.

## Phase 1 features

| Feature   | Commands / jobs              | Tier   | Built | Notes                                               |
| --------- | ---------------------------- | ------ | ----- | --------------------------------------------------- |
| `help`    | `/help`                      | guest  | ✅    | Lists only the commands the caller can use          |
| `ping`    | `/ping`                      | guest  | ✅    | Version                                             |
| `whoami`  | `/whoami`                    | guest  | ✅    | Private reply: your ID and tier                     |
| `admin`   | `/admin`                     | admin  | ✅    | Private reply: version, uptime, access-list counts (no IDs) |
| `status`  | `/status`                    | guest  | ✅    | Public. A "Checking…" box, then a live answer: open (green) or closed (red), and how long (if Pixel saw the change) |
| `status`  | job: announce changes        | n/a    |       | Sent through the announcer to the Discord channel   |
| `events`  | `/events`                    | guest  |       | The next few Discord scheduled events               |
| `info`    | `/info <topic>`              | guest  |       | Address, membership, contact (from `content/`)      |

The announcer and scheduler arrive with the announce-changes job (#3), and the CalendarPort with `events` (#4).

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
| `PIXEL_MEMBERS_FILE`          |        | Default `config/members.yaml`                  |
| `PIXEL_DATA_DIR`              |        | Default `data`. Runtime state, e.g. `space.state`; gitignored |
| `DISCORD_TOKEN`               | yes    |                                                |
| `DISCORD_APP_ID`              |        |                                                |
| `DISCORD_GUILD_ID`            |        | The only guild Pixel serves                    |
| `SENTRY_DSN`                  | yes    | Optional                                       |
| `LOG_LEVEL`                   |        | Default `info`                                 |
| `HEALTH_PORT`                 |        | Default `8080`                                 |
| `SPACEAPI_URL`                |        | Default `https://spaceapi.pixelbar.nl/`; http(s) only |

Planned, arriving with announcements (#3):

| Variable                      | Notes                                          |
| ----------------------------- | ---------------------------------------------- |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Optional. If unset, there are no announcements |
| `ANNOUNCE_ROUTES`             | JSON mapping each kind to publisher IDs, default `{"space.status":["discord"]}` |

Per-platform settings for later adapters (Telegram tokens, the Mastodon instance and account) will come from configuration when those adapters are built. No account is hard-coded.

## Local development

Every task goes through the [`justfile`](../justfile). Run `just` to list the recipes. `just dev` runs the bot with `tsx watch`, which also restarts it when `config/*.yaml` changes. `just check` runs the same lint, type-check and test steps that CI will run.

## Deployment (designed, not built in phase 1)

- **Platform:** Azure Container Apps, **exactly one replica**, no ingress, with a managed identity. A Discord gateway connection needs an always-on process. Two replicas would both connect and answer every command twice. That means max replicas = 1, and deploys should use a stop-then-start strategy, or a lock once a database exists.
- **Images:** built by GitHub Actions and pushed to `ghcr.io/pixelbar/pixel:<sha>`. The images contain no secrets and no access lists.
- **Secrets and access files:** Key Vault. The two YAML files are stored as secrets and mounted into the container as files.
- **Runtime state:** the container writes `space.state` to `/app/data`. A container's own filesystem is thrown away on every deploy, so without a mounted volume (for example Azure Files) the "open for 2h" detail resets after each deploy. Pixel works fine either way, so a volume is optional (#9).
- **Environments:** `dev` (Pixel Dev bot, test guild) and `prod` (Pixel bot, Pixelbar guild), with separate bots, tokens and vaults. Merges to `main` deploy to dev. Prod needs manual approval through a GitHub Environment.
- **Terraform layout:** `infra/bootstrap` (state storage, GitHub OIDC), `infra/modules/pixel`, and `infra/envs/{dev,prod}`. Secret values never go into Terraform variables or state.
- **CI (built):** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every PR and on pushes to `main`. It runs `just check` (lint, type-check, tests with coverage thresholds) and `just build`, uploads the coverage report, and checks that the Docker image builds. Actions are pinned to commit SHAs, and the workflow can only read the repo.
- **CD (planned):** on `main`, push the image to GHCR, create a Sentry release with source maps, and deploy to dev. Prod deploys need approval.

## Adding a platform (later)

- **Interactive** (for example Telegram): create `src/adapters/telegram/`. It builds a `PlatformActor`, calls the dispatcher and renders `Reply`. Telegram users get tiers only after account linking, which brings in Postgres (see the identity doc).
- **Outbound only** (for example Mastodon): implement `Publisher`, configure the instance and account through environment variables, and add the publisher's ID to `ANNOUNCE_ROUTES`. Features do not change.

## Open questions

- Where should private change history for `admins.yaml` and `members.yaml` live (a private repo, or Key Vault versions)?
- Which Azure subscription and which Sentry org? (Needed once infrastructure work starts.)
- Which channel should status announcements go to?

## Decision log

Record significant decisions as short ADRs in `docs/adr/NNNN-title.md`.

| #    | Decision                                                              | Status   |
| ---- | --------------------------------------------------------------------- | -------- |
| 0001 | TypeScript, ports-and-adapters core, interactive vs publisher adapters | proposed |
| 0002 | Phase 1 tiers from gitignored YAML files; admins in a separate file; fail closed | proposed |
| 0003 | No database until account linking or grants need one                  | proposed |
| 0004 | Azure Container Apps, single replica; GHCR; dev + prod                | proposed |
| 0005 | Sentry for errors (no PII), pino to stdout for logs                   | proposed |
