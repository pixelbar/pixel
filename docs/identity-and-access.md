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
# Pixel admins: full control of the bot. Same shape as members.yaml.
# id is "<platform>:<user id>". Discord ID: enable Developer Mode, right-click the user, Copy User ID.
# IDs MUST be quoted strings (see "Validation").
# Every admin ALSO needs an entry in members.yaml with the same id.
admins:
  - id: "discord:123456789012345678"
```

```yaml
# config/members.yaml
# Paying memberships. Anyone not listed is a guest.
# Managed by Pixel (admin commands rewrite it) and still safe to edit by hand.
members:
  - id: "discord:123456789012345678"   # an admin: also listed in admins.yaml
    tier: member
    note: "Jane Doe"
  - id: "discord:234567890123456789"
    tier: member                # member | friend | guest
    note: "optional, for humans"
    capabilities:               # optional named permissions, see the capability system
      - front-door
```

- Paths: `PIXEL_ADMINS_FILE` and `PIXEL_MEMBERS_FILE`, defaulting to `config/admins.yaml` and `config/members.yaml`.
- **The real files are gitignored**, because they link Discord accounts to membership, which is personal data. The repo contains `config/admins.example.yaml` and `config/members.example.yaml`.
- **Both files identify people the same way:** `id: "discord:<id>"`, the platform and the user ID, the same form as `actorRef` and the logs. That is so people on other platforms can be told apart once they exist, and so an admin entry matches its members entry exactly. Only `discord:` is accepted for now.
- **Admins are members too.** `admins.yaml` only says who is an admin. Each admin must also have an entry in `members.yaml`, which holds their membership level, capabilities and note. Pixel refuses to start if one is missing. An admin's effective tier is `admin` (which includes everything below it), and their entry's capabilities still apply. `/admin set-level` refuses admins, but `/admin capabilities grant` works on them.
- **Moving from the old formats:** in both files, replace `discordId: "<id>"` with `id: "discord:<id>"`, and drop the `name` from `admins.yaml` (it becomes the `note` of the admin's members entry). Add a members entry for each admin if they don't have one (`tier: member` is fine). Pixel refuses the old formats and says which entry is wrong, without echoing the ID.
- **`members.yaml` is bot-managed.** Admin commands change it, so it needs a **writable, persistent, snapshotted volume**, not a read-only mount. `admins.yaml` stays hand-edited (read-only is fine) and no command can touch it.
- `tier: guest` keeps the entry and its capabilities for someone who was demoted. They are treated as unlisted: no tier, not counted, and every tier-gated command refuses them.

### Validation (at startup, with zod)

- `id` must be a **string** like `discord:123456789012345678`: the platform, then a 17–20 digit user ID. If it's unquoted, or has no platform, Pixel **refuses to start**. Snowflakes are larger than JavaScript's safe integer range, so an unquoted number would be silently rounded to a different user.
- `tier` must be `member`, `friend` or `guest`. `capabilities` is an optional list of unique names (lowercase words joined by `-`, at most 50). Unknown keys are rejected, which catches typos like `teir`.
- A duplicate `id` within a file is an error.
- `admins` is a list of entries with an `id`, at least one, each unique, each unique, and each with an entry in `members.yaml`. An ID in both files is expected: admin wins, and the entry's other fields still apply.
- If either file is missing or invalid, startup fails with a clear message that never includes the file contents.

### Reloading

Both files are loaded at startup into an in-memory view that is replaced as a whole, never edited in place. A missing or invalid file still stops startup, so a lost file is a loud outage, never "everyone is a guest".

**Changes go through the access store** (`core/ports/access-store.ts`, implemented by `services/access-store.ts`). One change at a time it:

1. re-reads `members.yaml`, so edits made by hand aren't lost, and refuses if it has become invalid,
2. edits the YAML document, so comments, order and quoting survive (IDs are written as quoted strings),
3. re-validates the result and writes it to a temp file next to the original, then flushes it to disk,
4. checks the file wasn't edited in the meantime, keeps the old one as `members.yaml.bak`, and renames the temp file over the original (atomic),
5. only then swaps the in-memory view and records the change.

If any step fails, both the file and the view are unchanged, and the caller gets a message that contains no personal data. Steps 1 to 5 contain no `await`, so Node can't interleave two changes. That is why no lock is needed (Pixel runs as a single instance).

- **Admins are never written here.** Changing an admin's entry is refused.
- **Every change is audited**: an `access.changed` log event with who did it (ID, name, handle), who it was done to (ID), and the tier and capabilities before and after. Notes are never logged. The change also becomes a Sentry breadcrumb, so error reports show recent access changes. Sentry is not the audit record; a dedicated admin audit log is planned (#31).
- **Admin commands** use the store: `/admin set-level user: level: [reason:]` sets someone to `member`, `friend` or `guest`, and `/admin whois user:` shows what Pixel knows. Both are admin-only and private, act on the immutable user ID, refuse admins and bots, and say so when nothing would change. `guest` keeps the entry and capabilities; removing someone completely means editing the file by hand, then `/admin reload`. The optional reason goes into the audit log only (200 characters at most). Text from the file, such as a note, is shown as a code span, and names are escaped, so none of it can render as formatting, a link or a mention.
- **Hand edits made while the bot runs** are picked up by the next change, or by `/admin reload` (admins only), which re-reads both files and keeps the old data if they are now invalid. Restarting also works. In local development, `just dev` restarts automatically when the files change.

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

### Capabilities

Some features should reach specific people, **not everyone who is a member**, and not based on a Discord role. A **capability** is a named permission granted to an individual, for example a future `front-door`. There are none yet: the system is generic, and the first one arrives with the door lock (#29).

- **Declared in code.** `src/features/capabilities.ts` lists every capability (name and description). Admins can only grant names that exist there, so a typo can't create a silent grant. A command that requires an unknown name stops startup.
- **Commands require a tier and a capability**, for example `access: { minTier: "member", capability: "front-door" }`. **Both must hold**, so access can't outlive membership. The dispatcher is the only place this is checked, and the refusal is the same generic message as any other, with the real reason (`capability`) in the log.
- **Nothing implies a capability:** not a tier, not a Discord role, and not being an admin. An admin who needs one grants it to themselves, and that is audited like any other grant.
- **Guests never pass.** A guest holds no capabilities and is refused by every capability-gated command, even if the file lists some for them. Setting someone to guest therefore takes effect straight away, and their capabilities are kept but inactive.
- **Hidden from `/help`** for people who lack it. Discord still lists every registered command, so "secret" means unauthorised people are refused, not that the command is invisible (see [`discord-command-visibility.md`](discord-command-visibility.md)).
- **Admin commands** (admin only, private, audited through the store): `/admin capabilities grant user: capability: [reason:]`, `/admin capabilities revoke ...` and `/admin capabilities list [user:]`. The capability is picked from the registry. Granting to a guest is refused, since it would do nothing. With nothing registered they say "No capabilities are registered yet."
- **Names in the file that don't exist** (for example after rolling back a release) are ignored. Pixel logs a warning and reports them to Sentry (names only), at startup and on `/admin reload`.

**Threat model.** A grant lives only in `members.yaml`, and only an admin from `admins.yaml` can change it, through the store. A compromised Discord server, a role change or a forged display name can't grant a capability, because Pixel never reads roles to decide access and identifies people only by ID. Someone who gains write access to the files, or to an admin account, can grant one, which is why every change is audited and why the files live on a protected volume.

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
