# 0022. A capability can be revoked from one person, even when their level grants it

* Status: accepted
* Date: 2026-10-28

## Context

Since [ADR 0019](0019-level-capabilities.md), a capability can be given to everyone at a membership level, for example `ha-lights` to every member. What someone holds is their own grants plus their level's. That left no way to take one away from a single person who misuses it: `/admin capabilities revoke` could only remove their own grant, and `revoke-level` takes it from everyone at the level. Demoting them would take their membership away too, which is the wrong tool for misusing one capability.

## Decision

- **A members entry has an optional `revoked:` list**, holding capability names like `capabilities:` (same validation). A name in it is taken away from that person, whatever gave it.
- **A revocation wins over every grant.** What a person holds is their own grants plus their level's, minus their `revoked` list (`heldCapabilities` in `core/capabilities.ts`). It wins over their own grant too, so a hand edit that lists a name in both fails closed.
- **It follows the person, not their level.** Changing their level, revoking the capability from the level and granting it again, or giving it to a higher level, doesn't lift it.
- **`/admin capabilities revoke`** removes the person's own grant and, when their level gives the capability, adds it to their `revoked` list, as one change through the `AccessStore` (`set-capabilities` with `revoked`), audited with both lists before and after.
- **`/admin capabilities grant` and `grant-all`** lift a revocation, and add a grant of the person's own only for what their level doesn't already give. So lifting a revocation gives back exactly what the level would have given.
- **The person is DMed** when what they actually hold changes, now counting their level. A revocation of something they get from their level sends a DM; granting something their level already gives does not.
- **`/admin capabilities list`** shows a person's revocations and how many people each capability was revoked from. `/admin level get` shows them too.
- Revocations of a name that doesn't exist (any more) do nothing and aren't reported.

## Consequences

- Admins can stop one person from using, say, the lights without touching anyone else or their membership.
- A revocation is easy to forget: it stays after the level changes. `/admin capabilities list user:` and `/admin level get` show it, and `grant` lifts it.
- `members.yaml` stays the one source, so hand edits (and `just push`, whose audit now includes `revoked`) work as before.
- Rule 11 in AGENTS.md is unchanged in spirit: capabilities still come only from grants in `members.yaml` and are enforced only in the dispatcher. A revocation can only take one away.
