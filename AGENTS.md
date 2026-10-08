# AGENTS.md

Guidance for AI coding agents (and humans) working on Pixel, the assistant bot for the Pixelbar hackerspace.

Before making structural changes, read:
- [`docs/architecture.md`](docs/architecture.md): design, phase 1 scope, configuration
- [`docs/identity-and-access.md`](docs/identity-and-access.md): tiers and authorisation. **Read this before touching anything auth-related.**

## Current scope: phase 1

Build **only the core and the Discord adapter**. Do not add Telegram, Mastodon, a database or account linking unless a human asks for it. Design for them, but don't build them. **Terraform is starting:** first remote-state bootstrap (`infra/bootstrap`, #8), then the Container Apps module and `dev` (#9). **CD (#10, temporary):** `just deploy-dev` (local GHCR push) rolls Azure `dev`; merges to `main` deploy to prod and fail closed until #12. Do **not** add Postgres or any database; access, schedules and planned linking are files. Do not treat old GitHub issues as ground truth if they disagree with this file, `docs/architecture.md` Deployment, or `docs/runbook.md`.

## Project at a glance

- TypeScript on Node.js LTS, ESM only. All user-facing text is in English.
- Tiers: `guest` < `friend` < `member` < `admin`. `friend` and `member` are both paid memberships. Everyone else is a guest.
- Tiers come from two gitignored YAML files: `config/admins.yaml` and `config/members.yaml`.
- Every command goes through one dispatcher: resolve identity, check rate limit, check access, then run the handler.
- Sentry handles errors, pino writes logs, and `just` runs local tasks.

## Commands

Always go through `just`:

```sh
just dev              # run locally with hot reload
just check            # lint + typecheck + tests with coverage thresholds; must pass before you call a change done
just test             # tests only
just fmt              # auto-format (Biome, and Terraform if `terraform` is on PATH)
just validate-config  # validate the access list files
just tf-validate      # terraform fmt -check and validate infra/bootstrap
just deploy-dev       # local GHCR push + Azure pixel-dev (never prod; do not also just dev on that token)
```

If you need a new repeatable task, add a `just` recipe instead of documenting a raw command.

## Layout

```
src/
  instrument.ts         # Sentry init, loaded with --import before anything else
  index.ts              # entry point: config, Sentry reporter, adapters, health server, shutdown
  app.ts                # buildCore(): access lists, registry, dispatcher (shared with scripts)
  config.ts             # zod-validated env; the ONLY place that reads process.env
  testing/              # test fixtures (fake IDs, contexts); never imported by app code
  core/                 # platform-agnostic: access, command, dispatcher, registry,
                        #   identity, announcer, announcement types, calendar, errors, ports/
  features/<name>/      # one folder per feature; depends only on core/ and services/
  services/             # access-config, space-status, info-content
  adapters/discord/     # interactive + publishers + calendar source
  observability/        # logger, Sentry helpers, secret scrubbing, health
config/                 # *.example.yaml committed; real admins.yaml / members.yaml gitignored
data/                   # runtime state; gitignored. Safe to delete EXCEPT schedules.yaml (the scheduled posts)
content/info/           # markdown for /info topics, one file per topic; PUBLIC, reviewed
scripts/                # register-commands, validate-config
docs/                   # architecture, identity, ADRs
infra/                  # Terraform. bootstrap/ is #8 (apply by hand). modules/ and envs/ come with #9
```

## Security rules (non-negotiable)

1. **Every command declares `access.minTier`.** There is no default. The registry rejects commands without it.
2. **Authorisation happens only in the dispatcher.** Do not add tier checks inside adapters, and do not skip the dispatcher. A handler may add finer checks, but it must never loosen the dispatcher's decision.
3. **Identify users only by their immutable Discord user ID.** Never authorise based on usernames, display names or nicknames.
4. **`admin` comes only from `config/admins.yaml`** (entries with `ids` like `["discord:<id>"]`, each also present in `members.yaml` with the same ids). Never derive it from anything else.
5. **Fail closed.** Invalid or missing access files, or an empty admin list, mean the bot does not start. Discord IDs must be quoted strings (`^\d{17,20}$`). Never coerce numbers to strings.
6. **Never commit real access files, `.env`, tokens or Discord IDs of real people.** Use example files and obviously fake IDs in tests.
7. **Never log or report secrets.** When logging an action, identify the user with `actorLogFields()`, which gives `user` (`discord:<id>`), `userName` and `userHandle`, so moderators can recognise and ban them. Names are for humans only: act on the ID, never the name. Don't log message content or command arguments unless an ADR says so. The one exception is `/feedback`, where people choose to send a message to the maintainers: it goes only to the `FeedbackSink` (Sentry user feedback), is never logged (only its length), and is redacted first. No `console.log`: everything goes through the one logger, which writes to the console, a rotating file and Sentry Logs. Errors reported while a command runs carry the person's Discord ID automatically (the dispatcher scopes the run); when you report an error that happened because of a particular person outside a command, pass the `actor` to `captureBackground`. Don't write to `process.stdout`, `process.stderr` or a file yourself (the one plain message printed when startup fails, before there is a logger, is the exception), and don't add another logger.
8. **Private data gets private replies** (`Reply.private = true`, which is ephemeral on Discord).
9. **Commands that target a person use a `user` option** and act on the ID the handler receives, never on a name. A subcommand can't be looser than its group (the registry enforces it).
10. **`config/members.yaml` is changed only through the `AccessStore`** (`apply`). Never write that file from anywhere else, and never add a way to change `admins.yaml` at runtime. The store audits every change, so don't bypass it.
11. **Capabilities are declared in `src/features/capabilities.ts` and enforced only in the dispatcher.** A command that needs one says `access: { minTier, capability }` and both must hold. A capability is never implied by a tier, a role or being an admin, and a guest never passes. Don't check capabilities in handlers or adapters.
12. **Who may use a Home Assistant device is decided only by `core/home-access.ts`.** Reading needs the device's tier floor; acting needs the floor, plus `ha-admin` or the kind's capability, plus an action the devices file allows. Every `/ha` command and autocomplete use `canViewDevice`, `canActOnDevice`, `visibleDevices` and `actionableDevices`, and never re-implement the check. Refusals say `HOME_DENIED` and nothing about the device; the log has the real reason. Anything that changes a device goes through `DeviceControl` (`features/home/control.ts`): one catalogue call per action, no retries, no queueing, nothing sent when Home Assistant can't be read, one action at a time per device. Never call `home.callService` from anywhere else, and never pass anything a person typed as a service or its data. Doors are member-only (the kind's `minTier`) and can be switched off for everyone with `/admin doors off`; check the `KindSwitch` before acting on any kind, as `/ha set` and `/ha open` do.
13. **Discord roles are mirrored to, never read.** Pixel pushes a person's level to the mapped roles (`DISCORD_ROLE_MEMBER`, `DISCORD_ROLE_FRIEND`) through the `RoleMirror`, and never lets a role decide a tier, a capability or an admin. Don't add a way to read a role into identity, and don't touch roles that aren't mapped.
14. Changes to `core/access*`, `core/home-access*`, `core/home-kinds*`, `core/identity*`, `core/capabilities*`, `core/role-mirror*`, `adapters/discord/role-mirror*`, `core/dispatcher*`, `core/registry*` or `services/access-config*`, `services/access-store*` or `core/ports/access-store*` need **tests and a human reviewer**. Call this out in the PR description.

## Conventions

- **Dependency direction:** `adapters → core ↝ features → services`. `core` imports nothing from other folders. **discord.js is imported only in `src/adapters/discord/`.** When the core needs platform data, define a port in `core/ports/` and implement it in the adapter.
- **Adding a feature:**
  1. Create `src/features/<name>/index.ts` that exports a `create<Name>Feature(deps)` factory returning a `Feature`. Dependencies come in through `deps`, never as module-level singletons.
  2. Add it to `buildFeatures` in `src/features/index.ts`, then run `just register` so Discord sees it.
  3. Choose the lowest tier that is safe.
  4. Add tests.
- **Autocomplete:** an option's `suggest` function is a convenience, never validation. The command must validate the value it receives, because the platform doesn't check it came from the suggestions. Suggestions go through `Dispatcher.suggest`, so they get the same access checks as the command: don't call a suggest function any other way, and never list something the caller couldn't use. Keep them fast (Discord waits 3 s), and don't log what was typed.
- **Home Assistant:** features use the core `Home` and never import `home-assistant-js-websocket`: only `src/adapters/home-assistant/` does. `HOME_ASSISTANT_TOKEN` is a secret (never log it, put it in a message or a test fixture), and it must belong to a non-admin HA user. Calls fail closed: no queueing, no retries of actions, always a time limit. Don't cache reads. Tests use `src/testing/fake-home-assistant.ts`, never a real HA. Devices come only from `config/home-assistant/devices.yaml` (an allow-list, fail closed, errors never echo values), and what a device can do comes from its kind in `src/core/home-kinds/`: to add a kind, add a file there and list it in `HOME_KINDS`. `config/home-assistant/inventory.yaml` is written by Pixel (`services/home-inventory.ts`) and lists what Home Assistant has: it is **never** an allow-list. Don't read it back into Pixel, give entries a tier or actions, or offer them in a command: a device is usable only when a person has put it in `devices.yaml`.
- **Scheduled posts:** features post to a channel someone picked only through the core `ChannelPosts` (the Discord adapter plugs in the poster), never a platform directly. Check that the person may post there themselves (`ResolvedChannel.caller`), and that pings are opt-in. Long text goes in a `form` field (a modal), never a one-line option.
- **Announcements:** features hand an announcement (a typed kind from `core/announcement.ts`) to the `Announcer` and never call a publisher or a platform directly. Publishers decide how each kind looks on their platform. Never hard-code platform accounts, handles or channels: they come from config. Announcement text must be safe to show anywhere, and Discord posts must keep mentions disabled.
- **Calendar:** features read events from the core `Calendar` (neutral `CalendarEvent`s) and never touch a platform. An adapter plugs in a `CalendarSource` when it's ready. **Text written by other people** (event titles, locations and so on) must go through `escapeMarkdown` before it's put in a reply.
- **Content:** `content/info/*.md` is committed to a **public** repository, so never put secrets (wifi passwords, door codes, tokens) or personal data in it, and don't add member-only topics. Keep topics short and link to the canonical page on pixelbar.nl rather than copying it. Don't invent facts: every claim should come from Pixelbar's own pages or from the board. Adding, removing or renaming a topic needs the commands re-registered (`just register`), and CI loads the real content, so keep it valid.
- **Background work:** a feature that needs it declares `start()`, which returns a stop function. Don't start timers or listeners at import time or in a factory. Anything that runs from a timer must catch its own failures so none escapes as an unhandled rejection.
- **Config:** a new environment variable must be added to `config.ts`, `.env.example` and the architecture doc's config table.
- **Errors:** throw `UserFacingError` for problems the user should see. Anything else is reported to Sentry, and the user gets a generic reply.
- **Types:** `strict`, no `any` (use `unknown` and narrow it). Prefer `type` over `interface`.
- **Tests:** Vitest. Test features against a fake `CommandContext`. Test the Discord adapter's mapping logic with plain objects, never against a live Discord connection. Mock HTTP (SpaceAPI) at the service boundary.
- **Coverage:** `vitest.config.ts` sets an 80% overall floor, with strict floors (about 98%) for `core/`, `services/`, the Discord handlers and the observability helpers. Keep platform client code thin: put decisions in plain functions (see `adapters/discord/handlers.ts`) so they can be tested. Never lower a threshold to make a change pass. Add tests instead, or explain why in the PR.
- **Style:** Biome. Don't hand-format.
- **Runbook:** [`docs/runbook.md`](docs/runbook.md) is how volunteers run Pixel. A change to how Pixel is built, configured, deployed, monitored or recovered (an environment variable, a file it reads or writes, a command to run after a deploy, infrastructure) must update the matching section of the runbook in the same PR. The `🚧 Azure` markers are filled in as the infrastructure lands.
- **Dependencies:** keep them minimal. Explain why in the PR when you add one.

## Things to avoid

- Privileged Discord intents (`MessageContent`, `GuildMembers`, `GuildPresences`).
- Running more than one instance against the same bot token (every command would be answered twice).
- Committing generated files (`dist/`, coverage).
- Large refactors mixed into feature PRs.
