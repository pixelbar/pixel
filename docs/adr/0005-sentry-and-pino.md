# 0005. Sentry for errors, pino for logs

* Status: accepted
* Date: 2026-10-03
* Issue: #1

## Context

Operators need to see unexpected failures and which command ran, without putting bot tokens, message bodies or command arguments in a third-party service. Sentry is optional locally. The original decision-log line said "no PII": no IPs, no locals, no secrets, no Discord message content. The stable platform ID is attached on purpose so an issue can be traced and a person banned.

## Decision

- **Sentry** (`@sentry/node`, loaded from `src/instrument.ts` before the app) for unexpected errors. `UserFacingError` is shown to the user and not reported. No DSN means Sentry does nothing.
- The Sentry user is the stable platform ID (`discord:<id>`), with display name and handle so people can recognise them. All `dataCollection` categories are off (including stack-frame locals and IP inference). `beforeSend` scrubs anything that looks like a token.
- **pino** is the only logger. No `console.log`. Each line goes to **stdout**, a **rotating file** in `PIXEL_LOG_DIR` (about two weeks; empty turns the file off), and **Sentry Logs** (`info` and above). Tokens and authorization headers are redacted.
- Action logs use `actorLogFields()`: `user` (`discord:<id>`), `userName` and `userHandle`. Act on the ID, never the name. Do not log message content or command arguments unless an ADR says so.
- **Outgoing HTTP is not collected wholesale** (`httpBodies` and `urlQueryParams` stay off), because the space state API takes its credentials in the query string. Instead `HttpSpaceStateApi` hands a sanitised exchange (redacted address, state, status, capped body) to the reporter's `attach`, which sets it as a Sentry context and span attributes.
- A small HTTP server exposes `/healthz` (process alive) and `/readyz` (Discord gateway connected). Incoming probes are not Sentry request sessions.

## Consequences

- Local runs without a DSN are fine. CD / `just sentry-release` **fails closed** if `SENTRY_ORG`, `SENTRY_PROJECT` or `SENTRY_AUTH_TOKEN` are missing.
- Moderators can find and ban someone from the logs. Names are for humans only.
- A rotating file on disk is operator-only; it is not a public audit log (#31).
