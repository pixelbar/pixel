# AGENTS.md

Guidance for AI coding agents (and humans) working on Pixel, the assistant bot for the Pixelbar hackerspace.

Before making structural changes, read:
- [`docs/architecture.md`](docs/architecture.md): design, phase 1 scope, configuration
- [`docs/identity-and-access.md`](docs/identity-and-access.md): tiers and authorisation. **Read this before touching anything auth-related.**

## Current scope: phase 1

Build **only the core and the Discord adapter**. Do not add Telegram, Mastodon, a database, account linking, Discord role sync or Terraform unless a human asks for it. Design for them, but don't build them.

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
just check            # lint + typecheck + test; must pass before you call a change done
just test             # tests only
just fmt              # auto-format
just validate-config  # validate the access list files
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
                        #   identity, announcer, scheduler, errors, ports/
  features/<name>/      # one folder per feature; depends only on core/ and services/
  services/             # access-config, spaceapi, knowledge
  adapters/discord/     # interactive + publisher + CalendarPort
  observability/        # logger, Sentry helpers, pseudonymisation
config/                 # *.example.yaml committed; real admins.yaml / members.yaml gitignored
content/                # markdown for /info topics
scripts/                # register-commands, validate-config
docs/                   # architecture, identity, ADRs
```

## Security rules (non-negotiable)

1. **Every command declares `access.minTier`.** There is no default. The registry rejects commands without it.
2. **Authorisation happens only in the dispatcher.** Do not add tier checks inside adapters, and do not skip the dispatcher. A handler may add finer checks, but it must never loosen the dispatcher's decision.
3. **Identify users only by their immutable Discord user ID.** Never authorise based on usernames, display names or nicknames.
4. **`admin` comes only from `config/admins.yaml`.** Never derive it from anything else.
5. **Fail closed.** Invalid or missing access files, or an empty admin list, mean the bot does not start. Discord IDs must be quoted strings (`^\d{17,20}$`). Never coerce numbers to strings.
6. **Never commit real access files, `.env`, tokens or Discord IDs of real people.** Use example files and obviously fake IDs in tests.
7. **Never log or report secrets or raw Discord IDs.** Use the HMAC pseudonym helper. No `console.log`.
8. **Private data gets private replies** (`Reply.private = true`, which is ephemeral on Discord).
9. Changes to `core/access*`, `core/identity*`, `core/dispatcher*`, `core/registry*` or `services/access-config*` need **tests and a human reviewer**. Call this out in the PR description.

## Conventions

- **Dependency direction:** `adapters → core ← features → services`. `core` imports nothing from other folders. **discord.js is imported only in `src/adapters/discord/`.** When the core needs platform data, define a port in `core/ports/` and implement it in the adapter.
- **Adding a feature:**
  1. Create `src/features/<name>/index.ts` that exports a `create<Name>Feature(deps)` factory returning a `Feature`. Dependencies come in through `deps`, never as module-level singletons.
  2. Add it to `buildFeatures` in `src/features/index.ts`, then run `just register` so Discord sees it.
  3. Choose the lowest tier that is safe.
  4. Add tests.
- **Announcements:** features call `services.announcer.announce({ kind, text, … })`. They never call a publisher directly. Routing is config. Never hard-code platform accounts or handles.
- **Config:** a new environment variable must be added to `config.ts`, `.env.example` and the architecture doc's config table.
- **Errors:** throw `UserFacingError` for problems the user should see. Anything else is reported to Sentry, and the user gets a generic reply.
- **Types:** `strict`, no `any` (use `unknown` and narrow it). Prefer `type` over `interface`.
- **Tests:** Vitest. Test features against a fake `CommandContext`. Test the Discord adapter's mapping logic with plain objects, never against a live Discord connection. Mock HTTP (SpaceAPI) at the service boundary.
- **Style:** Biome. Don't hand-format.
- **Dependencies:** keep them minimal. Explain why in the PR when you add one.

## Things to avoid

- Privileged Discord intents (`MessageContent`, `GuildMembers`, `GuildPresences`).
- Running more than one instance against the same bot token (every command would be answered twice).
- Committing generated files (`dist/`, coverage).
- Large refactors mixed into feature PRs.
