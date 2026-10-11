# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, releases stay on 0.x: `Added` bumps minor, `Fixed`/`Changed` (and the other Keep a Changelog types) bump patch. The major version is never bumped automatically.

## [Unreleased]

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

[Unreleased]: https://github.com/pixelbar/pixel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/pixelbar/pixel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pixelbar/pixel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pixelbar/pixel/releases/tag/v0.1.0
