# Pixel

Pixel is a helpful assistant bot for members and visitors of the [Pixelbar](https://pixelbar.nl) hackerspace in Rotterdam.

- Ask whether the space is open, see upcoming events and get info about Pixelbar.
- Get an announcement when the space opens or closes.
- What you can do depends on your tier: guest, friend, member or admin.

Pixel starts on Discord. Its core doesn't depend on any platform, so other platforms (interactive ones like Telegram, outbound-only ones like Mastodon) can be added later as separate adapters.

> **Status:** phase 1 in progress. The core, the access lists and the Discord adapter work, with `/help`, `/ping`, `/status` (live from SpaceAPI), `/whoami` and `/admin status`, plus open/closed announcements in Discord, `/events` (from the server's scheduled events) and `/info` (short answers about Pixelbar). See [`docs/architecture.md`](docs/architecture.md) and [`docs/identity-and-access.md`](docs/identity-and-access.md). To hide admin commands from other people in Discord, see [`docs/discord-command-visibility.md`](docs/discord-command-visibility.md).

## Stack

| Concern          | Choice                                                   |
| ---------------- | -------------------------------------------------------- |
| Language         | TypeScript on Node.js LTS (ESM)                          |
| Discord          | [discord.js](https://discord.js.org)                     |
| Error reporting  | [Sentry](https://sentry.io)                              |
| Logging          | pino (JSON to stdout)                                    |
| Task runner      | [just](https://just.systems)                             |
| Infrastructure   | [Terraform](https://www.terraform.io) → Azure (later)    |
| Images           | GitHub Container Registry (later)                        |
| Tooling          | pnpm, Vitest, Biome, zod                                 |

## Getting started

### Prerequisites

- Node.js (the version in `.nvmrc`), with pnpm through `corepack enable`
- [just](https://just.systems/man/en/packages.html)

### Setup

```sh
pnpm install
cp .env.example .env                                # fill in the values
cp config/admins.example.yaml config/admins.yaml    # add yourself
cp config/members.example.yaml config/members.yaml
just validate-config
just register                                       # register slash commands on your test guild
just dev                                            # run Pixel with hot reload
```

### Your own dev bot

Never develop against the production bot.

1. Create an application at <https://discord.com/developers/applications>.
2. Under **Bot**, reset the token and put it in `DISCORD_TOKEN`. Put the application ID in `DISCORD_APP_ID`.
3. Create a test server, invite the bot with the `bot` and `applications.commands` scopes, and put the server ID in `DISCORD_GUILD_ID`.
4. Turn on Developer Mode in Discord, right-click yourself, choose **Copy User ID**, and add yourself to `config/admins.yaml`.

### Announcements

Pixel can post when Pixelbar opens or closes, in two styles. Each has its own channel setting, you can use either, both or neither, and they can be the same channel:

- **Live** (`DISCORD_ANNOUNCE_LIVE_CHANNEL_ID`): opening makes a "🟢 Pixelbar is open" post. Closing edits that same post to "🔴 Pixelbar is closed, was open from … to …". Opening again makes a new post, so a closed post never flips back.
- **Timeline** (`DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID`): a new post for every open and every close, never edited. Good for a status-only channel where you want a log of exactly when it opened and closed.

A change is posted once it has held for two checks in a row (about 30–60 seconds), so flicking the switch doesn't flood the channel. Nothing is posted when Pixel starts.

Give the bot these permissions in each channel: **View Channel**, **Send Messages** and **Embed Links**, plus **Read Message History** for the live style. Pixel checks this at startup and tells you in the logs if something is missing.

### Editing the `/info` topics

`/info` answers from markdown files in [`content/info/`](content/info), one per topic. You can edit them right in GitHub, and you don't need to know any code. A file looks like this:

```markdown
---
title: Becoming a member
summary: Member and Friend memberships, what they cost and how to join
order: 30
---
The text of the answer, in markdown…
```

- The **file name** is the topic's name (`membership.md`): lowercase letters, digits and dashes.
- `{{announcements-channel}}` in the text becomes a link to the announcements channel (set by `DISCORD_ANNOUNCEMENTS_CHANNEL_ID`). It's the only placeholder so far, and a misspelt one fails the checks.
- Keep answers **short** and link to the full page on the website, which stays the source of truth for prices, rules and opening times.
- **This repository is public.** Never put passwords, door codes or personal details in these files.
- A broken file fails the checks on your pull request, with a message saying what's wrong.
- Changes go live on the next deploy. **Adding, removing or renaming a topic** also needs `just register`.

### Access lists

Tiers come from two YAML files. **They are gitignored, because they contain personal data.**

- `config/admins.yaml`: Pixel admins (name and Discord ID).
- `config/members.yaml`: paying `member` and `friend` memberships (Discord ID and tier).

Everyone else is a `guest`.

Discord IDs **must be quoted strings**, because unquoted numbers lose precision. Pixel won't start if a file is missing or invalid. Run `just validate-config` to check the files.

### Environment variables

These are validated at startup. See `.env.example` and the [full list](docs/architecture.md#configuration).

| Variable                      | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `DISCORD_TOKEN`               | Bot token                                          |
| `DISCORD_APP_ID`              | Application ID                                     |
| `DISCORD_GUILD_ID`            | The one guild Pixel serves                         |
| `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` | Optional. Where announcements and the weekly poll are posted. `/info` points people at it |
| `DISCORD_ANNOUNCE_LIVE_CHANNEL_ID` | Optional. Channel for the **live** style: one post per opening, edited to "closed" when the space closes |
| `DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID` | Optional. Channel for the **timeline** style: a new post for every open and every close, never edited |
| `SPACEAPI_URL`                | Optional. Defaults to `https://spaceapi.pixelbar.nl/` |
| `PIXEL_DATA_DIR`              | Optional. Where Pixel keeps small bits of state (`space.state`, `announcements.state`). Defaults to `data/` |
| `PIXEL_TIMEZONE`              | Optional. The time zone `/events` shows times in. Defaults to `Europe/Amsterdam` |
| `PIXEL_CONTENT_DIR`           | Optional. Where the `/info` topics live (`info/*.md`). Defaults to `content` |
| `SENTRY_DSN`                  | Optional. Error reporting is off if unset          |

## Common commands

Run `just` to list every recipe.

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `just dev`             | Run Pixel locally with hot reload             |
| `just check`           | Lint, type-check, test and enforce coverage (what CI runs) |
| `just test`            | Run the tests                                 |
| `just coverage`        | Run the tests with coverage; fails below the thresholds in `vitest.config.ts` |
| `just build` / `just start` | Compile to `dist/` and run the build     |
| `just fmt`             | Auto-format                                   |
| `just validate-config` | Validate the access list files                |
| `just register`        | Register slash commands with Discord          |
| `just docker-build`    | Build the container image                     |

## CI

Every pull request and push to `main` runs [CI](.github/workflows/ci.yml). It runs `just check` (lint, type-check, tests with coverage thresholds) and the production build, and checks that the Docker image builds.

## Deployment

Not set up yet. The plan is a single container on Azure Container Apps, with `dev` and `prod` environments provisioned by Terraform. See [Deployment](docs/architecture.md#deployment-designed-not-built-in-phase-1).

## Security

Pixel decides who gets member-level access, so its security matters. If you find a vulnerability, email the board at bestuur@pixelbar.nl instead of opening a public issue.

## Contributing

Pixel is a Pixelbar community project. If you use an AI coding agent, point it at [`AGENTS.md`](AGENTS.md).

## License

TBD
