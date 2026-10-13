# 0003. No database: access, schedules and linking are files

* Status: accepted
* Date: 2026-10-08
* Issue: #15

## Context

The first architecture draft deferred a database until account linking or grants needed one. Issues #15 (PostgreSQL) and #18 (database-backed `/access` commands) sketched Azure Flexible Server, migrations and an audit table.

Phase 1 is a single replica. Access is already YAML. Admin commands (#25) rewrite `members.yaml` through an `AccessStore` port. Schedules need durable state that survives a deploy. Linking across platforms (#16) only needs a second id on an existing person.

## Decision

- **There is no database.** Access, schedules and planned account linking are files. Do not add Postgres because an old issue said so.
- `members.yaml` is bot-managed on a **writable Azure Files volume**. `admins.yaml` stays a read-only Key Vault secret.
- `schedules.yaml` lives in `PIXEL_DATA_DIR` on the same volume. Unlike the rest of `data/`, it is **not safe to delete**.
- Account linking will write `telegram:<id>` (and later others) onto the person's `members.yaml` entry through the access store. One-time codes stay in memory. No Postgres for that either.
- The `AccessStore` port means a database could still replace the file later. That swap is not planned.

## Consequences

- One replica is enough. A database lock is not a plan for keeping a single instance (#11).
- Volume snapshots back up `members.yaml` and schedules. Admin-file history is Key Vault versions or a private repo (still an open question).
- #18 closed: admin grant/revoke is `/admin level` and `/admin capabilities` on the file. #15 closed without a server.
