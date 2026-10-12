# Tiers and capabilities

Pixel decides what you may do from two things: your **tier**, and any **capabilities** an admin has given you. Both are checked every time you run a command, in one place, before the command runs.

## Tiers

Tiers are ordered: a higher tier can do everything a lower one can.

| Tier | Who |
| --- | --- |
| <PxTierBadge tier="guest" /> | Everyone who isn't listed. Being in the Discord server, or being known to Pixel, makes you a guest and nothing more. |
| <PxTierBadge tier="friend" /> | A paid "friend of Pixelbar" membership. |
| <PxTierBadge tier="member" /> | A paid Pixelbar membership. |
| <PxTierBadge tier="admin" /> | Pixel's operators. Admins are members too. |

Pixel knows you by your Discord user ID, never by your name or nickname, so changing your name changes nothing. Discord roles don't give you a tier either: Pixel sets the member and friend roles to match its own lists, never the other way round.

`/help` lists only the commands your tier allows, and `/whoami` shows the tier Pixel has for you.

::: info Your tier is wrong?
Ask a Pixel admin. Only they can change it, and every change is recorded.
:::

## Capabilities

A capability is a named permission for one person, for things that shouldn't reach every member. A command that needs one checks your tier **and** the capability: both must hold.

| Capability | What it allows |
| --- | --- |
| `schedule-posts` | Schedule messages and polls in channels you can post in, with `/schedule`. |
| `ha-lights` | Change lights in Home Assistant, with `/ha set`. |
| `ha-switches` | Change switches in Home Assistant, with `/ha set`. |
| `ha-doors` | Unlock doors, with `/ha open`. Members only. |
| `ha-admin` | Act on any Home Assistant device, whatever its kind. |

- **Nothing gives you a capability by itself.** Not your tier, not a Discord role, and not being an admin. An admin grants it to a person, and Pixel sends that person a direct message when it changes.
- **Guests never pass.** If someone goes back to guest, their capabilities stop working straight away.
- **They're narrow.** `ha-lights` doesn't reach a switch or a door.

## Home Assistant devices

Each device has its own lowest tier, set by the people who run Pixel. Seeing a device and its state needs only that tier. Changing it needs the tier, plus `ha-admin` or the capability for that kind of device, plus an action that device allows.

Doors are for members only, and an admin can switch all door control off at once.

When Pixel says no to a device, it doesn't say why: the reply is the same whether the device doesn't exist or you aren't allowed. That way it never gives away what's in the building.
