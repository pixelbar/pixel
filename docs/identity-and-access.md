# Identity and access control

> Status: **draft**. This is the most security-sensitive part of Pixel. Changes here need review from a second person.

Pixel has to know **who** is talking to it and **what they may do**. This document covers how users are identified, how tiers are assigned, and how every command is authorised. Phase 1 covers Discord only, with tiers held in config files. The later sections sketch how this grows to more platforms and other tier sources without changing features.

## Principles

1. **Deny by default.** Every command declares the minimum tier it needs. A command that declares none cannot be registered.
2. **One enforcement point.** Authorisation happens in the core dispatcher, never in adapters or feature handlers. Adapters cannot skip it.
3. **Identify by immutable platform IDs only** (Discord snowflakes). Never use usernames, display names or nicknames. Those can be changed or spoofed.
4. **Tier sources are explicit and few.** In phase 1, the only sources are two config files that operators control.
5. **Fail closed.** If the access config is missing or invalid, Pixel refuses to start. It never runs with "everyone is a guest" by accident, or worse, "everyone is an admin".
6. **Store as little personal data as possible** (GDPR).

## Tiers

Tiers are ordered: a higher tier includes everything a lower tier can do.

| Tier      | Who                                              | Phase 1 source              |
| --------- | ------------------------------------------------ | --------------------------- |
| `guest`   | Everyone not listed anywhere                     | Default                     |
| `friend`  | Paying "friend of Pixelbar" membership           | `config/members.yaml`       |
| `member`  | Paying Pixelbar member                           | `config/members.yaml`       |
| `admin`   | Pixel operators                                  | `config/admins.yaml`        |

`friend` and `member` are both **paid** memberships. Being in the Discord server, or being known to the bot, makes you a `guest` and nothing more.

`admin` lives in a separate file, so changes to it are easy to see and review on their own. Admins have every permission, whatever their entry in `members.yaml`.

Each command states its tier, for example `access: { minTier: "member" }`. `/help` only lists commands the caller can use.

## Phase 1: config-file tiers

### Files

```yaml
# config/admins.yaml
# Pixel admins: full control of the bot.
# Discord ID: enable Developer Mode, right-click the user, Copy User ID.
# IDs MUST be quoted strings (see "Validation").
admins:
  - name: Jane Doe              # for humans only; never used for authorisation
    discordId: "123456789012345678"
```

```yaml
# config/members.yaml
# Paying memberships. Anyone not listed is a guest.
members:
  - discordId: "234567890123456789"
    tier: member                # member | friend
    note: "optional, for humans"
```

- Paths: `PIXEL_ADMINS_FILE` and `PIXEL_MEMBERS_FILE`, defaulting to `config/admins.yaml` and `config/members.yaml`.
- **The real files are gitignored**, because they link Discord accounts to membership, which is personal data. The repo contains `config/admins.example.yaml` and `config/members.example.yaml`.
- In Azure (later), the files will be stored as Key Vault secrets and mounted into the container as files. Changing them means updating the secret and restarting the app.

### Validation (at startup, with zod)

- `discordId` must be a **string** matching `^\d{17,20}$`. If it's an unquoted YAML number, Pixel **refuses to start**. Snowflakes are larger than JavaScript's safe integer range, so an unquoted ID would be silently rounded to a different user.
- `tier` must be `member` or `friend`. Unknown keys are rejected, which catches typos like `teir`.
- A duplicate `discordId` within a file is an error.
- If an ID appears in both files, admin wins. Pixel logs a warning.
- `admins` must contain at least one entry.
- If either file is missing or invalid, startup fails with a clear message that never includes the file contents.

### Reloading

The files are loaded once, at startup, into an immutable in-memory map. Changing them requires a restart. That keeps things simple and predictable. In local development, `just dev` restarts automatically when the files change.

### Request flow

```
Discord interaction
  → adapter builds PlatformActor { platform: "discord", userId, displayName, chat: "dm" | "group", guildId? }
  → adapter refuses if guildId is set and isn't DISCORD_GUILD_ID
  → IdentityService.resolve(actor)
        asks every TierSource for this actor's tier; effective tier = highest result, or guest
  → dispatcher.authorize(command, principal, chat)
       ✗ → private reply "You don't have access to this", log 'command.denied', stop
       ✓ → handler(ctx with principal)
```

```ts
// core/ports/tier-source.ts
type TierSource = {
  name: string;
  tierFor(actor: PlatformActor): Promise<Tier | null>;
};
```

Phase 1 has a single `ConfigTierSource`. Later sources implement the same interface: Discord roles, database grants, linked identities. Neither the dispatcher nor any feature changes when a source is added.

Handlers receive a `Principal { platform, userId, displayName, tier }`. They never receive raw platform objects they could misuse to make their own authorisation decisions.

### Audit in phase 1

- **Tier changes:** the config files are the record of who has which tier. Editors should keep a private change history (for example a private repo or Key Vault secret versions).
- **Every action:** each executed command (`command.executed`, with its outcome), denial (`command.denied`) and rate limit (`command.rate_limited`) is logged as a structured event that names who did it: `{ event, command, tier, user: "discord:<id>", userName, userHandle }`. This means abusive users can be identified and banned. **Ban by `user` (the ID).** Names can change and can be faked to look like someone else.

## Context rules

- Commands can limit where they run: `access: { minTier: "member", contexts: ["dm"] }`.
- Anything that shows personal or member-only information replies **ephemerally** (only visible to the caller).
- Interactions from guilds other than `DISCORD_GUILD_ID` are refused, and the bot leaves those guilds.
- **Phase 1 has no DMs.** Commands are registered to the guild only, and Discord doesn't offer guild commands in DMs. Every interaction therefore has the `group` context. Supporting DMs later means registering global commands. The access model already handles DMs, because tiers come from the user ID rather than the guild.

## Privacy (GDPR)

- Phase 1 Pixel stores nothing on disk apart from the config files that operators maintain. It does not store message content.
- `/whoami` shows a person their Discord ID and effective tier, so they can check what Pixel thinks.
- Logs and Sentry identify users by their platform ID (`discord:<id>`). We chose this over pseudonyms because pseudonyms change whenever the key is rotated, which breaks tracking one user's issues over time. Logs and Sentry also record the user's display name and Discord handle, so people can recognise who did something. IDs and names count as personal data under GDPR, so the privacy notice must mention that they are stored in logs and Sentry, and log and Sentry retention apply. Message content and command arguments are never logged.
- Sentry's `dataCollection` options are all turned off: user info, headers, cookies, bodies, query params and stack-frame local variables. A `beforeSend` hook also scrubs anything that looks like a bot token.
- This needs a short privacy notice (linked from `/help`) before going live.

## Threats and mitigations (phase 1)

| Threat                                              | Mitigation                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Impersonation through a matching username or nickname | Authorisation uses only Discord user IDs                                  |
| An unquoted YAML ID is rounded to someone else's ID | Schema requires strings; startup fails otherwise                            |
| A broken config leaves Pixel open, or locks everyone out | Fail closed: invalid config means no start; at least one admin required |
| The member list leaks through the repo              | Real files are gitignored; only example files are committed                 |
| A bug in an adapter skips authorisation             | Central dispatcher check, plus tests that every command declares access     |
| Someone abuses the bot from a foreign guild         | Guild allow-list; the bot leaves other guilds                               |
| Bot token leaks                                     | Stored in `.env` or Key Vault, never logged, separate dev and prod bots     |
| Forged interactions                                 | Gateway connection, so payloads arrive over an authenticated socket. If HTTP interactions are used later, verify the Ed25519 signature |

## Testing requirements (phase 1)

- Config loading:
  - valid files
  - an unquoted numeric ID (rejected)
  - an unknown tier
  - a duplicate ID
  - an ID in both files
  - an empty admin list
  - a missing file
- Tier resolution: guest by default, friend and member from the file, admin overrides, highest across sources.
- Registry: every registered command has `access.minTier`.
- Dispatcher: a denied command never calls its handler, the denial is logged, and context restrictions are enforced.
- Discord adapter: an interaction from the wrong guild is refused, and ephemeral flags are set for private replies.

---

## Later phases (not in scope now)

These are recorded so that phase 1 doesn't make them harder. Each will get an ADR before it is built.

- **Discord role sync** (`DiscordRoleTierSource`): map roles in the Pixelbar guild to `friend` and `member`. Discord sends the caller's role IDs with every interaction, so this needs no privileged intent. `admin` stays file-based and is never derived from a Discord role.
- **More interactive platforms (Telegram):** these need **account linking** and therefore a database (Postgres): `people`, `identities`, `link_codes` and an append-only `audit_log`. The planned flow:
  1. The person runs `/link telegram` on Discord.
  2. Pixel replies ephemerally with a one-time code: about 40 bits of entropy, stored only as a hash, valid for 10 minutes, single use.
  3. The person sends the code to the bot in a Telegram DM. It is rate-limited, and redeeming it marks it used in the same transaction that creates the link.
  4. Both accounts are notified.
- **Database-backed grants:** admin commands (`/access grant|revoke`) with expiry and audit, possibly replacing `members.yaml`.
- **Freshness:** once tiers come from outside sources, re-verify a tier older than 24 hours before privileged commands, and reconcile every night.
