# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, releases stay on 0.x: `Added` bumps minor, `Fixed`/`Changed` (and the other Keep a Changelog types) bump patch. The major version is never bumped automatically.

## [Unreleased]

### Added

- A website in `docs/`, built with VitePress and themed with the Pixel design system: a landing page, a guide, every command with its tier and reply, and the maintainer docs and ADRs under `/maintainers/`. `just docs-install`, `just docs-dev` and `just docs-build` run it. It has its own `package.json` and lockfile, so the bot's dependencies and image don't change.

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

[Unreleased]: https://github.com/pixelbar/pixel/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/pixelbar/pixel/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/pixelbar/pixel/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/pixelbar/pixel/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/pixelbar/pixel/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pixelbar/pixel/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pixelbar/pixel/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pixelbar/pixel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pixelbar/pixel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pixelbar/pixel/releases/tag/v0.1.0
