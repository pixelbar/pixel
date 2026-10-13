# 0001. TypeScript, ports-and-adapters core

* Status: accepted
* Date: 2026-10-03
* Issue: #1

## Context

Pixel has to be useful on Discord now, and on other platforms later, without rewriting features each time. Interactive chat (commands, replies) and outbound announcements (space open/closed) are different jobs.

## Decision

- **TypeScript on Node.js LTS, ESM only.** Strict types, no `any`. All user-facing text is English.
- **Ports-and-adapters.** Dependency direction is `adapters → core ← features → services`. `core` imports nothing from the other folders.
- **Two kinds of adapter.** Interactive adapters turn a platform event into a `PlatformActor`, call the dispatcher, and render a `Reply`. Publisher adapters only post announcements. Discord is both. Mastodon is publisher-only. Telegram is later.
- **Platform SDKs stay in their adapter.** discord.js is imported only in `src/adapters/discord/`. When the core needs platform data, it takes a port (`core/ports/`) that the adapter implements.
- **One dispatcher.** Every command is rate-limited, identified, authorised, then handled. Features never talk to a platform.

## Consequences

- A new feature is one folder under `src/features/` and needs no platform plumbing.
- A new platform is an adapter; existing features do not change.
- Features are tested against a fake `CommandContext`. Adapter tests use plain objects, never a live Discord connection.
