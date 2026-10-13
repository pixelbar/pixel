# 0002. Phase 1 tiers from gitignored YAML files

* Status: accepted
* Date: 2026-10-03
* Issue: #1

## Context

Pixel must know who is talking and what they may do. Discord display names change. Discord roles can be granted by anyone with Manage Roles, so they are not a source of truth. The files name real people, so they cannot live in this public repository.

The full rules are in [`identity-and-access.md`](../identity-and-access.md).

## Decision

- Tiers are `guest` < `friend` < `member` < `admin`. `friend` and `member` are paid memberships. Everyone else is a guest.
- Phase 1 reads two **gitignored** YAML files: `config/admins.yaml` and `config/members.yaml`. Only `*.example.yaml` is committed.
- **`admin` comes only from `admins.yaml`.** It is never derived from Discord roles or from `members.yaml`. No command can write the admin file.
- Identify people only by **immutable Discord user ID**, as quoted strings (`^\d{17,20}$`). Never coerce numbers (snowflakes are bigger than JavaScript's safe integers). Never authorise on a username, display name or nickname.
- **Fail closed.** A missing or invalid file, or an empty admin list, means Pixel does not start. It never runs as "everyone is a guest" or "everyone is an admin".
- Every command declares `access.minTier`. There is no default. The registry rejects commands without it. Authorisation happens only in the dispatcher.

## Consequences

- Real access files, tokens and Discord IDs of real people never go in git. Tests use obviously fake IDs.
- Changing who is an admin is a file edit plus `/admin reload` (or a restart), not a slash command.
- Discord roles are mirrored *to* from Pixel's data, never read to decide a tier.
