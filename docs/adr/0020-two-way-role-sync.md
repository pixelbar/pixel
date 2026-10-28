# 0020. Discord roles are synced back into members.yaml

* Status: accepted
* Date: 2026-10-28

## Context

Pixel mirrored levels to Discord roles one way only: an admin set someone's level with `/admin level set`, and Pixel gave them the role. Moderators at Pixelbar also hand out the `member` and `friend` roles directly in Discord, and those people never reached `members.yaml`, so Pixel treated paying members as guests until an admin repeated the change in Pixel. The earlier decision (`identity-and-access.md`, "Later phases") rejected roles as a tier source to keep a compromised Discord or a careless moderator from granting access.

## Decision

- **A role sync reads the mapped roles every minute and writes `members.yaml` to match** (`core/role-sync.ts`). Someone holding the `member` or `friend` role gets that level (the higher one if they hold both), and someone at a mapped level who no longer holds its role, or has left the server, becomes `guest`. New people get an entry with their username as the note.
- **It is off unless `DISCORD_ROLE_SYNC=on`.** It needs the privileged **Server Members Intent** turned on in the Discord Developer Portal, because listing a server's members is gated by it. Pixel lists members over REST and does not request the intent on the gateway, so if it's off Pixel still connects and the sync pauses with a clear reason.
- **Roles are still never read when a command runs.** The dispatcher decides from the members file only; the sync is one more writer of that file, through the `AccessStore`, so every change is validated, written atomically and audited (`access.changed`, by the bot's own ID, reason "Has the member role" or "Discord role removed").
- **Safeguards:**
  - admins are never changed (they come from `admins.yaml`);
  - nothing runs unless every configured tier's role is working (exists, unambiguous, below the bot), so a renamed or deleted role can't make everyone look like they lost it;
  - a level whose role isn't mapped is left alone;
  - someone whose roles Pixel pushed in the last two minutes (an admin's `/admin level set` or `/admin sync`) is skipped, and so is anyone whose level changed after the roles were read, so the sync can't undo an admin's change;
  - more than 5 removals in one run are all held back and reported to Sentry once, as that looks like a mistake;
  - a persistent problem is reported once, not every minute.
- **Pushing still happens** on `/admin level set` and `/admin sync`. When the two disagree after the grace period, Discord's role wins.

This **supersedes** the one-way rule in AGENTS.md rule 13 and "Discord role mirroring" in `identity-and-access.md`.

## Consequences

- Anyone who can hand out the mapped roles in Discord can now give someone Pixel access, including capabilities granted to a whole level (for example `ha-doors` if it were given to members). Keep the roles' "Manage Roles" rights to trusted moderators, and think twice before granting sensitive capabilities to a level.
- Taking a role away (or someone leaving the server) makes them a guest within a minute. Their entry, note and own capabilities stay, inactive.
- Before turning the sync on, run `/admin sync` so everyone Pixel lists holds their role; otherwise the first run would hold back their removal and report it.
- One extra REST request per 1000 server members every minute.
