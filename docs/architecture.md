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
  userId: string;                // immutable platform ID
  displayName: string;
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
  embeds?: Embed[];
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
  3. check access, logging denials and admin commands
  4. validate the arguments against the declared options
  5. call the handler
  6. map errors to replies, reporting unexpected ones to Sentry with the command's tags
- **Announcer** sends each announcement kind to the publishers configured for it (`ANNOUNCE_ROUTES`). One publisher failing doesn't block the others, and failures go to Sentry. Phase 1 has one publisher: a Discord channel.
- **Scheduler** runs simple interval jobs in the process, for example polling SpaceAPI. Jobs report to Sentry Cron Monitors.
- **Rate limiter** keeps an in-memory token bucket for each user. That is enough because there is a single replica.
- **Errors:** `UserFacingError` is shown to the user and not reported. Anything else is reported to Sentry, and the user gets a generic reply.

## Discord adapter

- **discord.js v14, slash commands only.** Intents: `Guilds` and `GuildScheduledEvents`, neither of which is privileged. No `MessageContent`.
- **Guild allow-list:** interactions from any guild other than `DISCORD_GUILD_ID` are refused, and the bot leaves other guilds. There are no DMs in phase 1, because guild commands aren't available in DMs.
- **Mapping:** `CommandDefinition.options` become Discord slash command options. `Reply` becomes the message content plus embeds, truncated to Discord's limits. `private` becomes the ephemeral flag. **Mentions are always disabled** (`allowedMentions: { parse: [] }`), so no reply can ping `@everyone`.
- **The 3-second acknowledgement limit:** if a handler hasn't finished within 1.5 s, the adapter calls `deferReply()`, using the command's default visibility. A deferred reply's visibility can't be changed afterwards. If Pixel deferred publicly but the result is private, it deletes the placeholder and sends an ephemeral follow-up. A private result is never shown publicly.
- **Registration:** `just register` runs a script that builds the command list from the registry and sends it with a REST PUT to the guild. Commands are registered to the guild only, because Pixel serves just one, so updates show up instantly.
- **Publisher:** posts announcements to `DISCORD_ANNOUNCE_CHANNEL_ID`.
- **CalendarPort:** lists the guild's scheduled events through REST, with a short cache.

## Services and ports

| Service / port   | Purpose                              | Implementation                                                    |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `accessConfig`   | Admin and member lists               | Loads and validates the two YAML files at startup (`ConfigTierSource`) |
| `spaceApi`       | Is the space open?                   | Polls `SPACEAPI_URL` (default `https://spaceapi.pixelbar.nl/`, v0.13) every 60 s with a timeout. Caches the last state. Emits a change only after two consecutive identical readings |
| `CalendarPort`   | Upcoming events                      | Implemented by the Discord adapter                                |
| `knowledge`      | Info topics                          | Markdown files in `content/`                                      |

The SpaceAPI response has `state.open` but no `lastchange`, so Pixel records when it saw each change. That time is lost on restart, which is acceptable for phase 1.

## Phase 1 features

| Feature   | Commands / jobs              | Tier   | Built | Notes                                               |
| --------- | ---------------------------- | ------ | ----- | --------------------------------------------------- |
| `help`    | `/help`                      | guest  | ✅    | Lists only the commands the caller can use          |
| `ping`    | `/ping`                      | guest  | ✅    | Version                                             |
| `whoami`  | `/whoami`                    | guest  | ✅    | Private reply: your ID and tier                     |
| `admin`   | `/admin`                     | admin  | ✅    | Private reply: version, uptime, access-list counts (no IDs) |
| `status`  | `/status`                    | guest  |       | Open or closed, and since when (if known)           |
| `status`  | job: announce changes        | n/a    |       | Sent through the announcer to the Discord channel   |
| `events`  | `/events`                    | guest  |       | The next few Discord scheduled events               |
| `info`    | `/info <topic>`              | guest  |       | Address, membership, contact (from `content/`)      |

The announcer, scheduler, SpaceAPI service and CalendarPort arrive together with `status` and `events`.

There are no member-only features yet. The first one will be the real test of the access layer, but the plumbing and tests come first.

## Observability

- **Sentry** (`@sentry/node`) is initialised in `src/instrument.ts`, which is loaded with `--import` before the app. If no DSN is set, it does nothing.
  - Each command scope carries the tags `command`, `feature`, `platform`, `tier` and an HMAC user pseudonym.
  - All `dataCollection` categories are off, including stack-frame local variables, and `includeServerName` is false. `beforeSend` and `beforeBreadcrumb` scrub anything that looks like a token or a Discord ID.
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
| `DISCORD_TOKEN`               | yes    |                                                |
| `DISCORD_APP_ID`              |        |                                                |
| `DISCORD_GUILD_ID`            |        | The only guild Pixel serves                    |
| `SENTRY_DSN`                  | yes    | Optional                                       |
| `PSEUDONYM_KEY`               | yes    | HMAC key for user pseudonyms, at least 32 characters |
| `LOG_LEVEL`                   |        | Default `info`                                 |
| `HEALTH_PORT`                 |        | Default `8080`                                 |

Planned, arriving with `status`:

| Variable                      | Notes                                          |
| ----------------------------- | ---------------------------------------------- |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Optional. If unset, there are no announcements |
| `ANNOUNCE_ROUTES`             | JSON mapping each kind to publisher IDs, default `{"space.status":["discord"]}` |
| `SPACEAPI_URL`                | Default `https://spaceapi.pixelbar.nl/`        |

Per-platform settings for later adapters (Telegram tokens, the Mastodon instance and account) will come from configuration when those adapters are built. No account is hard-coded.

## Local development

Every task goes through the [`justfile`](../justfile). Run `just` to list the recipes. `just dev` runs the bot with `tsx watch`, which also restarts it when `config/*.yaml` changes. `just check` runs the same lint, type-check and test steps that CI will run.

## Deployment (designed, not built in phase 1)

- **Platform:** Azure Container Apps, **exactly one replica**, no ingress, with a managed identity. A Discord gateway connection needs an always-on process. Two replicas would both connect and answer every command twice. That means max replicas = 1, and deploys should use a stop-then-start strategy, or a lock once a database exists.
- **Images:** built by GitHub Actions and pushed to `ghcr.io/pixelbar/pixel:<sha>`. The images contain no secrets and no access lists.
- **Secrets and access files:** Key Vault. The two YAML files are stored as secrets and mounted into the container as files.
- **Environments:** `dev` (Pixel Dev bot, test guild) and `prod` (Pixel bot, Pixelbar guild), with separate bots, tokens and vaults. Merges to `main` deploy to dev. Prod needs manual approval through a GitHub Environment.
- **Terraform layout:** `infra/bootstrap` (state storage, GitHub OIDC), `infra/modules/pixel`, and `infra/envs/{dev,prod}`. Secret values never go into Terraform variables or state.
- **CI:** `just check` on every PR. On `main`: build, push, create a Sentry release, deploy to dev.

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
