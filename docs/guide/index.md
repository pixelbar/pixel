# Getting started

Pixel is the assistant bot for the [Pixelbar](https://pixelbar.nl) hackerspace in Rotterdam. It lives in the Pixelbar Discord server, where it answers slash commands and posts when the space opens and closes.

## Asking Pixel something

Type <kbd>/</kbd> in any channel of the Pixelbar Discord, then pick one of Pixel's commands from the list. Discord shows the options each command takes, and fills some in for you as you type.

```txt
/status
/info topic:membership
```

A few you'll use most:

- `/status`: is Pixelbar open right now, and for how long?
- `/events`: what's coming up.
- `/info`: short answers about Pixelbar. With no topic, it lists them.
- `/help`: the commands you can use. It only lists the ones your tier allows.

The [commands](/commands) page has every command, who can use it and what it needs.

## Who sees the reply

Every command says how it replies.

- **Public reply:** everyone in the channel sees it, like `/status` or `/events`.
- **Private reply:** only you can see it. Anything about you, like `/whoami`, or anything only some people may see, is always private.

## What you can do

What you can do depends on your tier: <PxTierBadge tier="guest" />, <PxTierBadge tier="friend" />, <PxTierBadge tier="member" /> or <PxTierBadge tier="admin" />. Being in the Discord server makes you a guest. Friend and member are the paid memberships. Some commands also need a capability, which an admin gives to one person at a time.

Run `/whoami` to see your tier and Discord ID as Pixel sees them. [Tiers and capabilities](./tiers) explains the rest.

::: tip Want to become a member?
Run `/info topic:membership` in Discord, or read about it on [pixelbar.nl](https://pixelbar.nl).
:::

## Announcements

Pixel posts in Discord when the space opens and when it closes. A change is posted once it has held for two checks in a row (about 30 to 60 seconds), so flicking the switch doesn't flood the channel.

Pixel can also toot the same news on Mastodon, and it says when it comes online and goes offline itself. Which channels it posts in is up to the people who run it.

## Feedback and problems

Use `/feedback` to send a message to Pixel's maintainers. It's private, and the reply tells you what's sent with it (your Discord name and ID, so they can follow up).

::: warning Found a security problem?
Email the board at [bestuur@pixelbar.nl](mailto:bestuur@pixelbar.nl) instead of posting it in Discord or opening a public issue.
:::

Pixel is a Pixelbar community project. The source is on [GitHub](https://github.com/pixelbar/pixel), and the [maintainer docs](/maintainers/) explain how it's built and run.
