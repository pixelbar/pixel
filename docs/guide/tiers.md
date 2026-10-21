# Tiers and capabilities

Two things decide what you can and can't do with Pixel: your **tier** and any **capabilities** you've been granted. Both are checked every time you run a command.

## Tiers

Tiers are ordered: a higher tier can do everything a lower one can.

| Tier | Who |
| --- | --- |
| <PxTierBadge tier="admin" /> | Pixel's operators |
| <PxTierBadge tier="member" /> | A paid Pixelbar membership. |
| <PxTierBadge tier="friend" /> | A paid "friend of Pixelbar" membership. |
| <PxTierBadge tier="guest" /> | Everyone who isn't listed. Being in the Discord server, or being known to Pixel, makes you a guest. |

Pixel uses your Discord ID - a unique identifier assigned by Discord to identify you. This ID is per account across Discord.

`/help` lists only the commands your tier allows, and `/whoami` shows the tier Pixel has for you.

::: info Your tier is wrong?
Ask a Pixel admin. Only they can change it.
:::

## Capabilities

A capability is a named permission for one person, for things that shouldn't reach every tier. A command that needs one checks your tier **and** the capability: both must hold.

| Capability | What it allows |
| --- | --- |
| `schedule-posts` | Schedule messages and polls in channels you can post in, with `/schedule`. |
| `revbank-link-admin` | Review, approve and revoke account links with `/revbank manage`. Members only, with separate authorisation from the RevBank service. |
| `spacestate` | Set the space open or closed, with `/spacestate set`. Members only. |
| `ha-lights` | Change lights in Home Assistant, with `/ha set`. |
| `ha-switches` | Change switches in Home Assistant, with `/ha set`. |
| `ha-doors` | Unlock doors, with `/ha open`. Members only. |
| `ha-admin` | Act on any Home Assistant device, whatever its kind. |

- **Nothing gives you a capability by itself.** Not your tier, not a Discord role, and not being an admin. An admin grants it to a person, and Pixel sends that person a direct message when it changes.
- **Guests never pass.** If someone goes back to guest, their capabilities stop working straight away.
- **They're narrow.** `ha-lights` doesn't reach a switch or a door.

## Home Assistant devices

Each device has its own minimum tier to be used. Seeing a device and its state needs only that tier. Changing it needs the tier, plus `ha-admin` or the capability for that kind of device, plus an action that device allows.


## Your RevBank account

You do not need a paid membership to link your own RevBank account. A link manager verifies and approves the link before Pixel can show your balance or bookings. Managing links requires the separate `revbank-link-admin` capability and service authorisation; it does not give access to another person's financial data.

[Set up your account link](/guide/#your-revbank-account).
