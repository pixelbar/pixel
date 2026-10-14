# Getting started

Pixel is the assistant bot for the [Pixelbar](https://pixelbar.nl) hackerspace in Rotterdam. It lives in the Pixelbar Discord server, where it answers slash commands and posts when the space opens and closes.

## Asking Pixel something

Type <kbd>/</kbd> in any channel of the Pixelbar Discord, then pick one of Pixel's commands from the list. Keep typing to narrow it down. Discord shows the options each command takes, and fills some in for you as you type.

<PxCommandTray query="/" :selected="1" caption="Type a slash and Discord lists Pixel's commands. Pick one with the arrow keys or a click." />

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

Pixel posts in Discord and toots on Mastodon when the space opens and when it closes.

## Feedback and problems

Use `/feedback` to send a message to Pixel's maintainers. This should not be used for any private information (better to DM @NinjaLikesCheez), feedback is **mostly** private, but will in the future automatically open public GitHub issues. This will include your username and the message you typed. You can see an [example here](https://github.com/pixelbar/pixel/issues/96)

::: warning Found a security problem?
Email the board at [bestuur@pixelbar.nl](mailto:bestuur@pixelbar.nl) and cc [ninjalikescheez@pixelbar.nl](mailto:ninjalikescheez@pixelbar.nl) instead of posting it in Discord or opening a public issue.

You can also use [GitHub's vulnerability reporting mechanism](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
:::

What Pixel stores about you, and how to ask for a copy or deletion, is in the [privacy notice](/maintainers/privacy).

Pixel is a Pixelbar community project. The source is on [GitHub](https://github.com/pixelbar/pixel), and the [maintainer docs](/maintainers/) explain how it's built and run.
