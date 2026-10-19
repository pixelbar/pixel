# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, releases stay on 0.x: `Added` bumps minor, `Fixed`/`Changed` (and the other Keep a Changelog types) bump patch. The major version is never bumped automatically.

## [Unreleased]

### Fixed

- `/spacestate`: the Sentry context for a failed call now says why the network failed (`errorCause`, such as `ENOTFOUND`, `ECONNREFUSED` or `UNEXPECTED_REDIRECT`), and shows the address without its query. Sentry was replacing the old redacted address with `[Filtered]`.
- `/admin doors on|off`: the `home.kind_switched` log now names the admin like every other action (Discord ID, name and handle) and carries the command, so moderators can recognise who switched door control. Before, it had only the Discord ID. It is still logged once per switch.
- Bot status: a run that had no online post of its own (stopped within the first few seconds, or its online post failed) no longer edits the newest online post to "offline" when it shuts down. During a deploy that post is the new version's, so the channel said Pixel was offline while it was running. It now says offline in a new post and leaves other runs' posts alone, and a run that is shutting down no longer posts "online" afterwards.
- Mastodon: a response from the instance is now read only up to the 64 KiB limit. A larger body (declared or streamed without a length) is cancelled instead of buffered in full or left open.
- Commands with a form (`/schedule`, closing time): opening the form now takes a token from the per-person command rate limit (refused and logged as `command.rate_limited` like any command), and errors reported while the form is being prepared are tied to the person's Discord ID in Sentry, as they are while a command runs. Submitting the form still takes its own token.
- `/schedule`: `when` no longer guesses. Four digits after a date are read the same with or without a month name: a time (`14 nov 1900` is 19:00, `14 nov 2030` is 20:30, as `14-11 2030` already was), and a year only beside another time (`14 nov 2030 19:00`) or when no clock reads them (`14 nov 2099`). Months must be English names or their short forms (`sep`, `sept`, `september`), so words like `junk`, `decent` or `mars` are refused instead of read as June, December or March.

## [0.17.0] - 2026-10-15

### Added

- `/spacestate`: Sentry now shows the request and response of each call to the space state API. A failed call carries them as a `spacestate_api` context on the error, and every call (successful ones too) puts them on the command's trace: the address, the state sent, the HTTP status, the content type and length, a short capped copy of the body, the outcome and how long it took. The user and token are shown as `[redacted]` and request headers are never sent. Nothing changes without a Sentry DSN.

## [0.16.0] - 2026-10-15

### Added

- `/spacestate`: optional `SPACESTATE_ADDITIONAL_HEADERS` (a JSON object of header names to values, sent with the state call), for headers the API needs on that call. It is a secret so the values stay out of the public repository: Key Vault `spacestate-additional-headers` on Azure, switched on by the new `spacestate_additional_headers_enabled` Terraform variable. Unset, nothing changes.

- `just pull dev|prod` and `just push dev|prod`: everything needed to work on an environment from any laptop. Each stack's `terraform.tfvars` is now shared as the Key Vault secret `terraform-tfvars` (a new `tooling` group in the secrets manifest that Terraform and the Container App never see). `just pull` also mirrors the share's `members.yaml`, `devices.yaml` and `announcement-routes.yaml` read-only. `just push` sends back the tfvars and app secrets, and refuses a tfvars that holds a secret, sets an undeclared variable or is for the other environment: secret Terraform inputs go in gitignored `secrets.auto.tfvars`. See the runbook's "Pull and push an environment". The first maintainer with a working tfvars runs `just push <env>` once to share it.

### Fixed

- `just push` no longer prints a `terraform.tfvars` that holds secrets: it checks the file before showing its diff, and the diff (in `just pull` too) hides the value of every sensitive Terraform variable, commented-out ones included. Before, a tfvars with a token in it was shown in full and only then refused (nothing was pushed). If you saw that output, clear your terminal's scrollback and consider rotating what it showed.

## [0.15.0] - 2026-10-15

### Added

- `just secrets-pull dev|prod` and `just secrets-push dev|prod`: sync an environment's app secrets (the `app` group in `infra/secrets.manifest.yaml`) between its Key Vault and `.env.<env>` / `config/admins.<env>.yaml`. A push reads the live vault, shows what would change by name and length (never a value; `admins.yaml` as a diff, checked against that env's `members.yaml`), pushes on a yes only if the vault hasn't changed meanwhile, reads it back, and offers to restart. `just restart dev|prod` restarts the Container App so it reads its secrets again. Needs Key Vault Secrets Officer. See the runbook's "Sync secrets with Key Vault" and [ADR 0016](docs/adr/0016-secrets-sync.md).
- `/spacestate set state:open|close`: members with the new `spacestate` capability can set the space open or closed from Discord. Pixel POSTs to the space's state API (`SPACESTATE_API_URL`, with the user and token from `SPACESTATE_USER` and `SPACESTATE_TOKEN`, which are Key Vault secrets `spacestate-user` and `spacestate-token` on Azure) and tells the person nothing changed if the API doesn't answer `SUCCESS`. The three settings go together or not at all; without them the command says it isn't set up. Grant the capability with `/admin capabilities grant`, and run `just register dev` / `just register prod` after deploying to add the command. Terraform gets a `spacestate_api_url` variable and the two write-only secrets.
- Website: each command on the commands page has a Copy button for its name. Public and private replies, and the capabilities a command needs, now look different from each other, and a tooltip explains each one when you hover over, tap or tab to it. Home Assistant and Scheduled posts sit under Members.
- Website: every command, admin ones included, is now a card of its own in the commands page's outline, with a link you can share (such as `/commands#ha-set`). Links opened straight to a heading no longer land under the top bar.
- Privacy notice ([`docs/privacy.md`](docs/privacy.md)) linked from `/help`, with log and Sentry retention and the access/deletion process in the runbook ([#7](https://github.com/pixelbar/pixel/issues/7)).
- Website: the privacy notice is on the docs site, linked from the guide, the sidebar and the maintainers overview.

### Changed

- Secrets: `infra/secrets.manifest.yaml` is now the one list of the secrets Pixel keeps in Azure Key Vault (names, environment variables, what turns each on; never values). Terraform derives its Key Vault secrets and the Container App's secret environment variables from it, with the same result as before, and a test fails if `config.ts`, `.env.example`, the Terraform variables or the docs disagree with it. `just validate-secrets` checks the file and lists the secrets. This is groundwork for a Key Vault sync tool ([ADR 0015](docs/adr/0015-secrets-manifest.md)). Nothing to apply or redeploy.
- Website: the `/feedback` card now says that your message and username may be made public, so you shouldn't include anything private.
- `/feedback` now says, in its description and its reply, that your message and username may be made public, and the reply links the privacy notice. `/help` links the privacy notice on the website (`https://pixelbar.nl/pixel/privacy`) instead of GitHub. Run `just register dev` / `just register prod` after deploying so Discord shows the new `/feedback` description.

## [0.14.0] - 2026-10-14

### Fixed

- During a deploy, the old version going offline no longer overwrites the new version's "Pixel is online" post. Each run now only updates its own post.
### Added

- The Release workflow registers prod slash commands after it rolls `pixel-prod` (a second Environment `prod` approval), so `just register prod` is no longer a manual step after a release. It takes the app, guild and token reference from the running `pixel-prod`. **One-time setup:** a maintainer sets `github_register_principal_id` in `infra/envs/prod` (from `az identity show -g pixel-bootstrap -n pixel-github-prod --query principalId -o tsv`) and applies prod, which lets `pixel-github-prod` read the `discord-token` secret and nothing else ([ADR 0014](docs/adr/0014-release-registers-commands.md)). Until then the job fails with that instruction and `just register prod` still works.

## [0.13.0] - 2026-10-14

### Added

- A third open/closed announcement style, **single**: the channel only ever holds the current status. Each open or close posts the new status (closed shows when, and how long it was open) and then deletes the previous post. A stale status post is corrected at startup.
- `/admin announcements set|remove|list`: admins choose which channels get open/closed announcements and in which style (live, timeline or single), while Pixel runs. Any number of channels, one style each, e.g. a timeline in #announcements and a live post in #general. Saved in `data/announcement-routes.yaml` on the persist volume. Run `just register dev` / `just register prod` after deploying to add the command.

### Removed

- `DISCORD_ANNOUNCE_LIVE_CHANNEL_ID` and `DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID` (and their Terraform variables): open/closed announcements are only set with `/admin announcements` now. **After deploying, set them again**: `/admin announcements set style:live channel:<the live channel>` and `style:timeline` for the timeline channel, or announcements stop. Leftover values in an env file are ignored, and `data/announcements.state` is no longer used (safe to delete); a live channel finds its open post again from its recent messages.

### Fixed

- The Terraform workflow's prod plan no longer fails with 403 on PRs that change Terraform files: it plans with `-refresh=false`, because GitHub is deliberately not allowed to read prod's Key Vault secrets (ADR 0012). Run `just tf-plan prod` locally for the real plan before applying.

## [0.12.0] - 2026-10-14

### Added

- `/admin capabilities grant-all user:` gives someone every capability in one audited change, admins included. Individual capabilities can still be revoked.
- Architecture Decision Records [0001](docs/adr/0001-ports-and-adapters.md)–[0005](docs/adr/0005-sentry-and-pino.md) (accepted): TypeScript ports-and-adapters, YAML access lists, no database, Azure Container Apps, and Sentry plus pino. 0006 and 0007 stay unused.
- `just ha-devices dev|prod`: add or remove Home Assistant devices from a searchable list where what's listed starts ticked (`/` to search, `s` to show what's ticked, esc to go back), and push to that env's `devices.yaml` on Azure. It pulls the remote file (the truth) into a local mirror under `config/home-assistant/<env>/`, stops if the mirror has edits the remote doesn't, validates, shows the diff and pushes only on a yes and only if the remote hasn't changed meanwhile. Doors start with no actions, and dev offers none. Then `/admin reload`.

### Changed

- `just register and `just command-access` take `dev` or `prod` so they cannot mix Pixel Dev and production Discord tokens. Use `just register prod` with `.env.prod` (`PIXEL_ENV=prod`); `just deploy-dev` calls `just register dev`.
- CI/CD runs each expensive job only when its inputs change ([`dorny/paths-filter`](https://github.com/dorny/paths-filter) + [`.github/path-filters.yml`](.github/path-filters.yml)): `just check` for app/scripts/config paths, Docker/GHCR when the image would change (including test-only `src/` edits), and the docs workflow for `docs/` (Biome + site build). Docs, changelog and infra-only changes no longer run app CI or publish an image.
- Merges to `main` no longer roll `pixel-prod` or publish the docs site. A maintainer runs the **Release** workflow on `main` to cut the version from Unreleased, tag `vX.Y.Z`, create a GitHub Release, publish that image, roll `pixel-prod` after Environment `prod` approval, and publish the VitePress site to GitHub Pages.

### Removed

- `inventory.yaml` and everything behind it: Pixel no longer writes a list of what Home Assistant has, so the hourly sync, the `PIXEL_HOME_SYNC_MINUTES` setting, and the "N known, synced X ago" line in `/admin status` and the inventory line in `/admin reload` are gone. `just ha-devices` reads Home Assistant live when you add devices. Remove `PIXEL_HOME_SYNC_MINUTES` from your env if you set it (it is ignored), and delete any leftover `home-assistant/inventory.yaml` from the dev and prod file shares (harmless either way).

### Fixed

- Terraform plan jobs skip Azure login unless `infra/` Terraform files change, so README or `justfile` edits do not refresh Key Vault secrets. GitHub’s identity is not Secrets User (ADR 0012); that refresh is a 403.

## [0.11.0] - 2026-10-13

### Added

- Pixel's status in the Discord member list now shows whether Pixelbar is open ("Watching Pixelbar is Open", green; "Watching Pixelbar is Closed", yellow). It follows the same confirmed changes as the announcements (PIXEL-N).

### Fixed

- Pixel's member-list presence is set again after Discord starts a new gateway session, so it is not blank until the next open or close.

## [0.10.3] - 2026-10-13

### Fixed

- `/ha list` now pluralises its groups when there is more than one device ("Lights · 2", "Switches · 2", not "Light · 2" or "Switchs") (PIXEL-4).

## [0.10.2] - 2026-10-13

### Changed

- `/feedback` now shows people the message as it was sent, in its private reply (PIXEL-M).

## [0.10.1] - 2026-10-12

### Changed

- `/info` with no topic now lists the topics in a private reply, so the menu no longer clutters the channel. Answers to a topic stay public (PIXEL-K).

## [0.10.0] - 2026-10-12

### Added

- Production Azure environment (`infra/envs/prod`, #12): own Key Vault, Files share and Container App (`pixel-prod`). Merges to `main` still publish GHCR; after GitHub Environment `prod` approval they roll `pixel-prod` to that same image digest (no rebuild). `just deploy-dev` is unchanged. Coding agents cannot `just tf-apply prod` unless `PIXEL_APPLY_PROD=1`.

### Fixed

- `terraform.yml` plan-prod fails closed unless GitHub Environment `prod` has `ARM_CLIENT_ID` and `ARM_TENANT_ID` (OIDC variables, same table as bootstrap). Those were missing, so the first #12 PR check never reached `terraform plan`.

## [0.9.0] - 2026-10-12

### Added

- A website in `docs/`, built with VitePress and themed with the Pixel design system: a landing page, a guide, every command with its tier and reply, and the maintainer docs and ADRs under `/maintainers/`. `just docs-install`, `just docs-dev` and `just docs-build` run it. It has its own `package.json` and lockfile, so the bot's dependencies and image don't change. A [Docs site](.github/workflows/docs.yml) workflow builds it on pull requests that touch `docs/` and publishes it to GitHub Pages from `main`.

## [0.8.0] - 2026-10-11

### Added

- Home Assistant operator docs: setup on a test instance, threat model, [ADR 0011](docs/adr/0011-home-assistant.md), and a runbook step for a door action that looks wrong.

## [0.7.1] - 2026-10-11

### Fixed

- Terraform apply no longer replaces the **dev** Container App image that `just deploy-dev` pinned (`lifecycle.ignore_changes` on `azurerm_container_app.this` only). Prod (#12) still lets apply set `container_image`.

## [0.7.0] - 2026-10-11

### Added

- Mastodon publisher: when `MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN` are set, space open/closed announcements are tooted on the configured account (visibility defaults to `unlisted`). Other kinds stay off unless `MASTODON_ANNOUNCE_KINDS` lists them. Unset means off; a Mastodon outage is reported and does not affect Discord.

## [0.6.0] - 2026-10-11

### Added

- Date tokens in user-set posts accept a whole-day offset (`{{date+2}}`, `{{day+2}}`) from the scheduled occurrence, so a Monday post can talk about Wednesday.

## [0.5.0] - 2026-10-11

### Added

- `/schedule edit` lets the Discord user who scheduled a post or poll change it before it goes out (content, and optionally `when` / repeat / name). Autocomplete and the list show only their still-upcoming items. Already-posted or other people's schedules get a generic refusal.
- `/schedule preview` and the private reply after `/schedule message`, `/schedule poll` and `/schedule edit` fill `{{date}}` and the rest of the date family as of the next occurrence (the same clock as the post), including a poll's question and answers. The stored body is unchanged.

## [0.4.0] - 2026-10-11

### Added

- User-set posts (`/schedule` messages and polls, the closing-time file) fill `{{date}}`, `{{day}}`, `{{month}}`, `{{year}}` and `{{dateWithTime}}` when they are posted, in `PIXEL_TIMEZONE` (Europe/Amsterdam). Unknown tokens are left as written.

## [0.3.0] - 2026-10-10

### Added

- `/closing-time` posts a configurable closing reminder (members). The same message is posted automatically after a confirmed space-closed announcement. Off when no channel is set. Admins set the text with `/admin closing-time set` (a modal that prefills the saved message); it is written to `data/closing-time.md` on the persist share.

### Fixed

- Discord “already acknowledged” / “unknown interaction” replies are treated as a second instance on the same token, not as a crash.

## [0.2.0] - 2026-10-10

### Added

- Keep a Changelog, automatic `package.json` version bumps from Unreleased notes, and a CI gate that requires a changelog entry unless the pull request is labeled `skip-changelog`.
- Discord DM when a capability is granted or revoked.

### Changed

- Doors only lock and unlock. `/ha open` always unlocks; Pixel never unlatches (`lock.open`).

## [0.1.0] - 2026-10-09

Phase 1 as shipped on `main` through 2026-10-09. Item dates are merge or commit dates from git.

### Added

- Phase 1 core, access lists and Discord adapter: `/help`, `/ping`, `/whoami`, `/admin` (2026-10-03, #1).
- `/status` from SpaceAPI and open/closed announcements (2026-10-03, #20, #21).
- `/events` from the guild's scheduled events (2026-10-03, #22).
- `/info` answers from reviewed markdown topics (2026-10-03, #23).
- Admin member and capability commands, plus Discord role mirroring (2026-10-03 to 2026-10-04, #30, #32, #33, #34, #35).
- Autocomplete for command options (2026-10-04, #44).
- `/feedback` to the maintainers via Sentry (2026-10-04, #46).
- Home Assistant: device allow-list, `/ha list` / `status` / `set` / `open`, capabilities, and an admin door switch (2026-10-04 to 2026-10-08, #45, #49, #50, #51, #52, #53, #54, #57, #64).
- `/schedule` for channel messages and polls (2026-10-07, #62).
- Online/offline posts for Pixel itself, and a Sentry cron check-in (2026-10-07, #58, #59).

### Changed

- Structured logs to the console, a rotating file and Sentry Logs (2026-10-04, #55).
- Operations runbook for volunteers (2026-10-05, #56).
- Azure Terraform bootstrap, Container Apps `dev` stack, and GHCR CD that keeps `main` off prod (2026-10-08, #65, #66, #67, #68).
- Sentry traces, profiles, sessions and runtime metrics (2026-10-08, #69).
- Infra overview with Azure and GitHub diagrams (2026-10-09, #75).

[Unreleased]: https://github.com/pixelbar/pixel/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/pixelbar/pixel/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/pixelbar/pixel/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/pixelbar/pixel/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/pixelbar/pixel/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/pixelbar/pixel/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/pixelbar/pixel/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/pixelbar/pixel/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/pixelbar/pixel/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/pixelbar/pixel/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/pixelbar/pixel/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/pixelbar/pixel/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/pixelbar/pixel/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/pixelbar/pixel/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/pixelbar/pixel/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/pixelbar/pixel/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/pixelbar/pixel/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pixelbar/pixel/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pixelbar/pixel/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pixelbar/pixel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pixelbar/pixel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pixelbar/pixel/releases/tag/v0.1.0
