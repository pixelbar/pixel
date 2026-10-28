# 0019. Capabilities can be granted to a membership level

* Status: accepted
* Date: 2026-10-28

## Context

Capabilities (#28) were granted only to individual people, and the rule was that nothing implies one: not a tier, not a role, not being an admin. Some capabilities are meant for everyone at a level, for example `ha-lights` for every member. Granting one to each member separately is tedious, is easy to forget for a new member, and leaves grants behind when someone stops paying (they become inactive at guest, but stay in the file).

## Decision

- **The members file has an optional `tiers:` section**, with `friend` and `member` keys, each holding `capabilities` like a person's entry. `guest` and `admin` are rejected: a guest never passes a capability check, and admin status still implies nothing.
- **A level grant reaches that level and every level above it** (a `friend` grant reaches members too), so the same ordering applies as for `minTier`.
- **It follows the person's membership level in `members.yaml`, not their effective tier.** An admin gets a level's capabilities through their own members entry (usually `member`) and gets nothing from being an admin. An admin whose entry is `guest` gets none.
- **What a person holds** is their own grants plus their level's. `StoreCapabilitySource` combines them, and the dispatcher's check doesn't change: both `minTier` and the capability must hold, and a guest gets nothing.
- **Changes go through the `AccessStore`** (`setTierCapabilities`), with the same steps as `apply`: re-read, validate, edit the YAML document, atomic write with `.bak`, then swap the view and write an `access.changed` audit record (`kind: set-tier-capabilities`, `target: tier:<level>`, before and after). The admin commands are `/admin capabilities grant-level` and `revoke-level`.
- **Nobody is DMed** about a level change. It can reach every member at once, and the per-person DM was there to tell someone a grant was made for them.
- **Any registered capability can be granted to a level**, including `ha-doors` and `ha-admin`. That is a choice for admins to make, not something the code forbids.

This **supersedes** the "nothing implies a capability: not a tier" rule in `identity-and-access.md` and AGENTS.md rule 11, for grants made to a level. A capability still never comes from being an admin or from a Discord role.

## Consequences

- One admin command can give a capability to everyone at a level. Granting `ha-doors` to `member` would let every member open the building, and a taken-over account of any member could too (see [`home-assistant.md`](../home-assistant.md#threat-model)). The audit record and `/admin capabilities list` show it, and `revoke-level` takes it back at once.
- Revoking from a level doesn't touch individual grants, so someone granted a capability on their own keeps it. `/admin capabilities revoke` on someone who has it only from their level says so and changes nothing.
- A person's capabilities now depend on their level: demoting a member to friend takes away the member level's grants straight away, and promoting a friend gives them.
- `members.yaml` is still the one source, so a hand edit followed by `/admin reload` works as before, and unknown names in `tiers:` are warned about and ignored like a person's.
