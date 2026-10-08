# Operations runbook

How to run Pixel day to day and what to do when something goes wrong. It is written for volunteers: anyone with the right access should be able to follow it without the original author.

**This is a living document.** Bootstrap (#8) is applied. The Container Apps `dev` stack (#9) is in Terraform. CD (#10): **temporarily** `just deploy-dev` (a local GHCR push) rolls Azure `dev`, and merges to `main` go to prod (fail closed until #12). Every procedure has two parts:

- **Today:** what works now, with Pixel run locally or in a container you start yourself. Everything here has been checked against the code.
- **🚧 Azure:** a marker for the steps that still depend on hosting that is not applied, or on #12. Search for `🚧` to find what's left.

Before you change anything on **prod**, read "Rules of thumb" below.

## Contents

- [Rules of thumb](#rules-of-thumb)
- [Who and what](#who-and-what)
- [Quick reference](#quick-reference)
- [Running Pixel today](#running-pixel-today)
- [Access lists](#access-lists)
- [Moderation](#moderation)
- [Home Assistant](#home-assistant)
- [Terraform bootstrap](#terraform-bootstrap)
- [Azure Container App (`dev`)](#azure-container-app-dev)
- [Secrets](#secrets)
- [Deploys](#deploys)
- [Incidents](#incidents)
- [Sentry](#sentry)
- [Privacy requests](#privacy-requests)
- [Disaster recovery](#disaster-recovery)
- [Keeping this up to date](#keeping-this-up-to-date)

## Rules of thumb

1. **Try it in dev first.** Dev has its own bot, token and guild. Prod is the real Pixelbar server.
2. **Never run two instances against one bot token.** Every command would be answered twice. Check that nothing else is running before you start one.
3. **Never paste a secret into chat, an issue, a pull request or a log.** Tokens go in the secret store (or your local `.env`) and nowhere else. If one leaks, rotate it now (see [Secrets](#secrets)) and tell the others.
4. **Identify people by ID, never by name.** Names and nicknames can be changed or faked. The ID can't.
5. **Pixel fails closed.** A missing or broken access file stops it from starting, on purpose: that is a loud outage, never "everyone is a guest". Fix the file; don't work around it.

## Who and what

| | |
| --- | --- |
| **Environments** | `dev` (Pixel Dev bot, test guild) and `prod` (Pixel bot, Pixelbar guild). Separate bots, tokens and secrets. |
| **Who is on the hook when the bot is down** | 🚧 Not decided. Put a named contact (and a backup) here, and where to reach them. |
| **Where Pixel runs** | Today: wherever someone starts it (see [Running Pixel today](#running-pixel-today)). Azure subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`, West Europe. Resource groups `pixel-bootstrap`, `pixel-dev`, `pixel-prod`. Container App `pixel-dev` in `pixel-dev` (one replica, no public ingress) after #9 apply. `just deploy-dev` rolls that app; `main` rolls `pixel-prod` once #12 exists. |
| **Where the code and CI are** | GitHub, `pixelbar/pixel`. CI runs lint, type-check, tests and an image build on every pull request. CD on `main` publishes `ghcr.io/pixelbar/pixel:<sha>`. |
| **Access you may need** | The Discord Developer Portal (bot token), a Discord role that can manage the server, the Sentry project, the GitHub repo, the Home Assistant admin account, Owner on the Pixel Azure subscription (to apply bootstrap), and the host. |

## Quick reference

| I want to… | Do this |
| --- | --- |
| See when Pixel last started, crashed or stopped, and which version | The announcements channel: a "🟢 Pixel is online" post per run, edited to "🔴 offline" on shutdown, or marked "⚠️ stopped unexpectedly" after a crash |
| See if Pixel is up and which version | `/ping` in Discord, or `/admin status` (version, Node, uptime, access list counts, Discord roles, Home Assistant) |
| Check readiness from outside | `GET /healthz` (process is up) and `GET /readyz` (200 only while the Discord gateway is connected, otherwise 503), on `HEALTH_PORT` (default 8080) |
| Read the logs | Console, or the file `data/logs/current.log` (JSON lines, about two weeks kept), or **Logs** in Sentry |
| Re-read the access lists and devices after a hand edit | `/admin reload` (admins only). Or restart |
| Check the config files without starting Pixel | `just validate-config` |
| Make Discord pick up new or changed commands | `just register` (after a deploy that changes commands) |
| Look up a person | `/admin level get user:` (admins only) |

Useful `just` recipes: `just dev`, `just check`, `just validate-config`, `just register`, `just command-access`, `just docker-build`, `just deploy-dev`, `just tf-validate`. Run `just` to list them all.

## Running Pixel today

There is no hosted deployment yet. To run Pixel (for dev, or as a stopgap):

**From source** (needs Node.js and pnpm):

```sh
just install
cp .env.example .env            # then fill in the values
cp config/admins.example.yaml config/admins.yaml     # then edit both files
cp config/members.example.yaml config/members.yaml
just validate-config            # must say OK
just register                   # once, and after command changes
just dev                        # or `just start` after `just build`
```

**In a container:**

```sh
just docker-build                                  # tags pixel:local, version = the git SHA
docker run -d --name pixel \
  --env-file .env \
  -v "$PWD/config:/app/config" \
  -v "$PWD/data:/app/data" \
  -p 8080:8080 pixel:local
```

Mount the **config directory writable**: `members.yaml` is changed by admin commands (written to a temp file next to it, then renamed, with the previous copy kept as `members.yaml.bak`). `data/` holds state and the log files. **`data/schedules.yaml` is not safe to delete** (it is the scheduled posts). The rest of `data/` is. See [`architecture.md`](architecture.md) for every setting.

Only ever run one copy. Before starting one: `docker ps`, and check nobody else has Pixel running with the same token.

**Azure (`dev`, after apply):** Container App `pixel-dev` in resource group `pixel-dev`. Secrets from Key Vault `pixel-dev-kv`. `admins.yaml` is a read-only Key Vault file. `members.yaml`, Home Assistant files and `data/` (including `schedules.yaml`) live on Azure Files share `pixel` on account `pixeldevdata`, mounted at `/app/persist`. How to apply, seed files, and restart: [Azure Container App (`dev`)](#azure-container-app-dev). Do not start a local Pixel on the same token while that app is up.

## Access lists

Tiers come from two files: `config/admins.yaml` (hand-edited) and `config/members.yaml` (changed by admin commands, and safe to edit by hand). Read [`identity-and-access.md`](identity-and-access.md) before changing either.

**Add or change a member or friend (the normal way):**

1. In Discord, an admin runs `/admin level set user:<person> level:<member|friend|guest>` with an optional reason.
2. Check it with `/admin level get user:<person>`.

That's all: Pixel updates `members.yaml` itself, keeps `members.yaml.bak`, and logs an `access.changed` event with who did it. If Pixel is configured to mirror Discord roles, it also sets the person's role. `/admin sync` re-applies the roles for everyone if they ever drift.

**Remove someone completely:** `/admin level set … level:guest` keeps their entry. To delete the entry, edit `members.yaml` by hand (remove the whole `- ids: …` block), then `/admin reload`. Admins can't be changed from Discord (see below).

**Add or remove an admin:** admins are never changed from Discord. Edit `config/admins.yaml` by hand, and make sure every admin also has an entry in `members.yaml` with the same IDs. Then run `just validate-config` and `/admin reload` (or restart). Admin IDs must be quoted strings like `"discord:123456789012345678"`. Getting an ID: in Discord, enable Developer Mode, right-click the person, **Copy User ID**.

**If you edited a file and Pixel won't start:** run `just validate-config`. It names the file, the position and the field, never the value. Fix that and start again. A bad `admins.yaml` or a missing admin list is a startup failure by design. `members.yaml.bak` is the previous good copy if you need to go back.

**Capabilities** (extra permissions such as `ha-lights`): `/admin capabilities grant|revoke user: capability:` and `/admin capabilities list [user:]`. They only ever work for members, friends and admins, never guests.

**Azure (`dev`):**

- **`admins.yaml`:** Key Vault secret `admins-yaml`, mounted read-only. Edit the secret (`az keyvault secret set --vault-name pixel-dev-kv --name admins-yaml --file config/admins.yaml`), then restart the Container App. Versions of the secret are history.
- **`members.yaml` and Home Assistant files:** on the Azure Files share. Admin commands already rewrite `members.yaml` in place. A hand edit: upload the file to the share (see [Azure Container App (`dev`)](#azure-container-app-dev)) then `/admin reload`, or restart. Daily backups of the share keep 14 days.
- Prod (#12) will be the same layout in `pixel-prod`.

## Moderation

**Find what someone did.** Pixel logs every command, denial and rate limit with the person's stable ID. Search by ID, never by name:

```sh
# from the log file (JSON lines): what did discord:123456789012345678 do?
jq -c 'select(.user == "discord:123456789012345678")
       | {time: (.time/1000|todate), event, command, outcome, reason, msg}' data/logs/*.log
```

The events to look for: `command.executed` (with `outcome`), `command.denied`, `command.rate_limited`, `access.changed`, and for Home Assistant `home.action` and `home.action_denied`. In Sentry, open **Logs** and filter on the `user` attribute (`discord:<id>`), or look at the issue's user. The names in the logs (`userName`, `userHandle`) are there so you can recognise the person, but act on the ID.

**Stop someone using Pixel.** Pixel has no block list of its own (#6 decided Discord's own moderation covers it):

1. **Ban or time them out in Discord** (Server Settings → Members). A banned person can't use any command.
2. If they were a member or friend, run `/admin level set user:<person> level:guest`, and revoke any capabilities with `/admin capabilities revoke`, so nothing lingers if they come back.
3. Note what you did and why.

If you suspect someone's **account was taken over** (for example it is unlocking things or running device actions it never used to), do 1 and 2 at once, then check the logs for what it did, and tell the board.

## Home Assistant

Pixel talks to Home Assistant (HA) with a long-lived token from a **non-admin** HA user, and can only touch the devices in `config/home-assistant/devices.yaml` (read [`architecture.md`](architecture.md), "Home Assistant"). `/admin status` shows whether it's connected, how many devices are allowed and how many it knows of.

**Add a device:** open `config/home-assistant/inventory.yaml` (Pixel rewrites it from HA; it lists what exists and allows nothing). Copy the entry you want into `devices.yaml`, then set who may use it (`minTier`) and which `actions` are allowed (none means read-only). Run `just validate-config`, then `/admin reload`: the reply says how many devices there are and warns about entities HA doesn't know. Nothing in the inventory is usable until it's in `devices.yaml`.

**Take a device away from people quickly:** remove its `actions` (or the whole entry) from `devices.yaml` and `/admin reload`. Changing it back is the same in reverse.

**Doors:** members with `ha-doors` (or `ha-admin`) can open a door with `/ha open door:` or use `/ha set`. A door can't be opened to friends: `just validate-config` refuses a door with `minTier: friend`.

**Stop all door control at once:** `/admin doors off` (admins only). Nobody can then act on any door from Pixel until an admin runs `/admin doors on`. It survives restarts. Check it in `/admin status`. If you think an account with door access was taken over: `/admin doors off` first, then revoke their capabilities (see [Moderation](#moderation)), then look at what it did by searching the logs for `"kind":"door"` and their ID. If the switch file in `data/` is ever unreadable, doors start off and say so in the logs; `/admin doors on` fixes it.

**Emergency stop for everything:** revoke Pixel's token **in Home Assistant** (profile of the Pixel user → Security → Long-lived access tokens → delete). Pixel's next call is refused and the connection turns off. It takes effect at once and doesn't depend on Pixel being healthy. To bring it back, make a new token and put it in `HOME_ASSISTANT_TOKEN` (see [Secrets](#secrets)).

**If Home Assistant is unreachable:** see [Incidents](#incidents).

**How Pixel reaches HA:** locally, `HOME_ASSISTANT_URL` is usually the Nabu Casa cloud URL. On Azure the preferred path is a Tailscale sidecar so the container talks to HA on the LAN (#9, #43). A Nabu Casa URL still works if the sidecar is not there yet.

## Terraform bootstrap

`infra/bootstrap` (#8) is applied. It does **not** run Pixel. It created remote Terraform state and GitHub → Azure login without a client secret.

**Who can apply:** Owner on subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`. Later changes: [`infra/bootstrap/README.md`](../infra/bootstrap/README.md).

**GitHub Environment `prod`** (reviewers, deploying branch `main`) needs `ARM_CLIENT_ID`, `ARM_TENANT_ID` and `ARM_SUBSCRIPTION_ID` as **variables**, not secrets. CD on `main` uses them for OIDC to prod. Values: [`infra/bootstrap/README.md`](../infra/bootstrap/README.md). Environment `prod` is not created yet. Azure `dev` uses local `az` (`just tf-apply dev`, `just deploy-dev`), not those variables.

**Do not** apply bootstrap from GitHub Actions, and do not run a second Pixel bot against the same Discord token.

## Azure Container App (`dev`)

Terraform: `infra/modules/pixel` + `infra/envs/dev` (#9). **Do not apply until a maintainer says so.** Steps, secret names, volume layout and tear-down: [`infra/envs/dev/README.md`](../infra/envs/dev/README.md).

```sh
just tf-validate
just tf-plan dev
just tf-apply dev    # only when told
```

After apply, Discord still will not answer until Key Vault secrets exist (`write_secrets` or `az`), `members.yaml` is on the share, an image exists, commands are registered, and nothing else is using that bot token.

**Restart the app** (after rotating a secret or changing `admins.yaml`):

```sh
az containerapp revision restart -g pixel-dev -n pixel-dev
```

**See that there is exactly one replica:** `az containerapp replica list -g pixel-dev -n pixel-dev -o table`. If a command is answered twice, stop the extra instance (a laptop, or an old revision). Never raise `max_replicas`. Overlap during a deploy is #11.

**Home Assistant:** Tailscale sidecar is preferred (`tailscale_enabled = true` plus Key Vault `tailscale-auth-key`). A Nabu Casa URL in `home_assistant_url` plus `home-assistant-token` still works when Tailscale is off. Set both URL and token, or neither. Dev must not point at the real doors.

**Rough cost:** about €40–55/month for always-on `dev` without Tailscale, plus about €15 with the sidecar. West Europe. Not a quote.

🚧 **CD / prod:** publishing `ghcr.io/pixelbar/pixel:<sha>`, Sentry releases, register-on-deploy, and prod are #10 and #12. No apply on merge from this stack.

## Scheduled posts

Members with the `schedule-posts` capability schedule messages and polls with `/schedule` (`/admin capabilities grant user: capability:schedule-posts`). `/schedule list` shows them all, with who made each in the file.

After a deploy that adds `/schedule`, run **`just register`** so Discord lists the commands, then grant the capability. No new environment variables: times use `PIXEL_TIMEZONE` (Europe/Amsterdam). The bot needs Send Messages in the target channel, and Send Polls if it will post polls.

- **They live in `data/schedules.yaml`.** Back it up with the access files; deleting it deletes every schedule.
- **Stop one now:** `/schedule pause` or `/schedule delete`. To stop someone's schedules, revoke their capability: each of theirs pauses the next time it's due.
- **A post didn't go out:** look in the logs for `schedule.failed` (Pixel can't post there any more: permissions, a deleted channel), `schedule.skipped` (Pixel was down more than an hour past the time) or `schedule.paused_no_access`. Pixel never retries a failed post; the next occurrence tries again.
- **If the file is invalid** (a bad hand edit), nothing is posted or changed, and `/schedule` says so. Fix it or restore it from backup, then restart. Pixel never overwrites it while it's invalid.

## Secrets

Every secret lives in the secret store for its environment (a local `.env` for development, Key Vault `pixel-dev-kv` in Azure `dev`) and nowhere else. Pixel never logs them, and scrubs anything shaped like a Discord or Home Assistant token from logs and Sentry, but don't rely on that. After rotating, **restart Pixel**: secrets are read once at startup.

| Secret | Where it comes from | Rotate when |
| --- | --- | --- |
| `DISCORD_TOKEN` | Discord Developer Portal; Key Vault `discord-token` | It may have leaked, someone with access leaves, or on a schedule |
| `HOME_ASSISTANT_TOKEN` | A long-lived token in HA; Key Vault `home-assistant-token` | It may have leaked, or the Pixel user changes |
| `SENTRY_DSN` | Sentry project settings; Key Vault `sentry-dsn` | It's being abused, or you move projects |
| Tailscale auth key | Tailscale admin; Key Vault `tailscale-auth-key` | It may have leaked, or you rotate tagged keys |
| `admins.yaml` | Hand-edited; Key Vault `admins-yaml` (not a token) | When admins change |

**Rotate the Discord bot token** (the old one stops working the moment you reset it, so expect a short outage):

1. Discord Developer Portal → the right application (dev or prod!) → **Bot** → **Reset Token**. Copy it once; it isn't shown again.
2. Put it in the secret store as `DISCORD_TOKEN`.
3. Restart Pixel. Check `/ping`, and that `/readyz` is 200.
4. You don't need `just register`: the application and its commands haven't changed.

**Rotate the Home Assistant token:**

1. In HA, as the **non-admin** Pixel user: Profile → Security → Long-lived access tokens → create a new token, then delete the old one.
2. Put the new one in the secret store as `HOME_ASSISTANT_TOKEN`, and restart Pixel.
3. `/admin status` should say Connected with no warning about an admin token. If it warns that the token belongs to an admin, the token is from the wrong user: redo it with the non-admin user.

**Rotate the Sentry DSN:** Sentry project → Settings → Client Keys: create a new key, disable the old one, update `SENTRY_DSN`, restart. Check that a test event arrives.

**If a secret leaked:** rotate it first, then work out where it leaked from. Check the logs and Sentry for the time window. A leaked Discord token lets someone act as the bot in your server, so treat it as urgent.

**Azure (`dev`):** put values in gitignored `terraform.tfvars` with `write_secrets = true` and re-apply (not stored in state), or `az keyvault secret set --vault-name pixel-dev-kv --name discord-token --file -` (and the other names above), then `az containerapp revision restart -g pixel-dev -n pixel-dev`. Prod vaults are #12. Never commit secret values.

## Deploys

**What is deployed:** `/ping` ("Pixel `<version>` is up") or `/admin status`. The version is the git SHA the image was built from (`just docker-build` sets it; CD will too). `docker ps` shows the image tag if you run it in a container.

**Roll back to the previous version:** start the previous image tag instead (keep the last few tags, and don't prune them). Rolling back is safe for Pixel's own data: `members.yaml` and the other files stay as they are. If the older version doesn't know a capability that is in `members.yaml`, it logs a warning and ignores it. After a rollback that changes which commands exist, run `just register` so Discord matches.

**After a deploy that adds, removes or renames commands:** run `just register` against that environment's guild. Topic changes to `/info` need it too.

**Deploys must stop the old instance before starting the new one,** so two never answer at once. Expect a short gap while it restarts. Overlap during a revision swap is still #11.

**Azure CD (temporary routing, [ADR 0010](adr/0010-ghcr-cd.md)):**

- **`dev`:** from this tree, `just deploy-dev`. Builds **linux/amd64** (Azure cannot run Mini arm64 images), pushes `ghcr.io/pixelbar/pixel:<sha>` (or `dev-dirty-*` if the tree is dirty) and `:dev`, then `az containerapp update` on `pixel-dev` only. Needs `gh auth refresh --scopes write:packages,read:packages,repo`, Docker, and `az` on subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`. Max replicas stay 1. Does not start Pixel. CI does not deploy pull requests (so a local SHA is not overwritten by another CI head).
- **`prod`:** merges to `main` ([`.github/workflows/cd.yml`](../.github/workflows/cd.yml)) push the SHA and moving tag `main`, then deploy that SHA. If `infra/envs/prod` or prod Key Vault secrets are missing, that job **fails closed**. Discord will not answer on prod until #12. Never copy `pixel-dev-kv` or the Mini local Discord token into prod.
- GHCR: CI uses `GITHUB_TOKEN` (`packages: write` on the publish job only). Local uses `gh`. The package should be **public** (no secrets in the image) so Azure can pull. Org package visibility cannot be changed via the API; until a maintainer uses GitHub → Packages → pixel → Change visibility → Public, `just tf-apply dev` needs `container_registry_server` / `container_registry_username` and Key Vault `ghcr-pull-token`.
- Prod Azure login is GitHub Environment OIDC (`ARM_*` variables). Missing `ARM_*` fails closed. `dev` uses local `az`.
- Neither path applies Terraform. If `pixel-dev` does not exist yet, apply #9 first (`just tf-apply dev`), then `just deploy-dev`.
- Rollback: `az containerapp update -g pixel-dev -n pixel-dev --image ghcr.io/pixelbar/pixel:<previous-sha>` (same for `pixel-prod` once it exists). Confirm one replica: `az containerapp replica list -g pixel-dev -n pixel-dev -o table`.
- If `pixel-dev` is up, do not start the Mini bot (`just dev`) on the same Pixel Dev token.

🚧 **Sentry releases and `just register` from CD** are still later. After a deploy that changes commands, register against that environment's guild by hand.

## Incidents

**The bot is offline or doesn't answer**

1. Look at Pixel's latest status post in the announcements channel: "offline" means it was shut down, "stopped unexpectedly" means it crashed (check the logs and Sentry for why), and a missing post for a start you expected means it never got as far as Discord. If Sentry's `pixel-<env>` cron monitor alerted, it tells you when the last good check-in was. `/ping` in Discord. No answer? Check `/readyz` and `/healthz`. 503 on `/readyz` means the process is up but the Discord gateway isn't connected.
2. Look at the logs for the last few minutes (console, `data/logs/current.log` or Sentry Logs). A start-up failure prints `Pixel failed to start:` with the reason (a bad config file, a missing admin list, an invalid token).
3. Common causes: a bad edit to an access file (`just validate-config`), a reset or expired Discord token (rotate it, restart), Discord itself being down (check Discord's status page, then wait), or the host being out of resources.
4. Restart it. If it keeps failing, roll back (see [Deploys](#deploys)).
5. Tell the team in the channel what you found.

**Azure (`dev`):** Portal → Container App `pixel-dev` → Log stream / Console, or `az containerapp logs show -g pixel-dev -n pixel-dev --follow`. Restart: `az containerapp revision restart -g pixel-dev -n pixel-dev`. 🚧 Where alerts arrive is still not decided.

**Duplicate replies (every command answered twice)**

Two instances are connected with the same token. Find and stop the extra one: `docker ps` locally, and check that nobody has a copy on a laptop or another server. In Azure: `az containerapp replica list -g pixel-dev -n pixel-dev -o table` must show one replica (same for `pixel-prod` once it exists). Never fix this by raising limits. CD pins min=max=1.

**SpaceAPI is down** (`/status` says "Couldn't check")

Pixel can't tell whether the space is open, so it says so rather than guess. Check `https://spaceapi.pixelbar.nl/` yourself. When it's back, `/status` works again by itself and changes are announced as normal. Nothing to restart. Pixel never announces a change it didn't see itself, so a restart or an outage never produces a stale announcement. If it stays down, that is a problem with the space's own server, not with Pixel.

**Home Assistant is unreachable** (`/admin status` shows not connected or off; `/ha` says it can't reach it)

1. `/admin status` shows why. "Off: the token was refused" means the token was revoked or replaced: make a new one (see [Secrets](#secrets)). Not connected means it can't reach the HA URL: check HA is up and the network or tunnel between them.
2. Pixel keeps reconnecting by itself, never queues an action and never retries one, so nothing will fire late when it's back.
3. After fixing it, `/admin reload` re-checks the connection.

**Someone has the wrong access**

`/admin level get user:<person>` shows their tier, where it comes from and their capabilities. Fix it with `/admin level set` or by editing the files (see [Access lists](#access-lists)).

## Sentry

Sentry gets three things: errors (with the tags `command`, `feature`, `platform`, `tier` and the user's ID, so you can see who ran into it), Logs (every log line at `info` and above), and **User Feedback** from people using `/feedback`.

- **Where alerts go:** 🚧 not decided. Set up alert rules for new issues in prod, and write here who is notified and where (email, Discord channel).
- **Pixel going quiet:** Pixel checks in with a Sentry cron monitor, `pixel-prod` or `pixel-dev` (Sentry → **Crons**), every 5 minutes while it's connected to Discord. If check-ins stop (a crash, a hang, the host down) or say it's disconnected, the monitor opens an issue within about ten minutes, and closes it by itself when Pixel is back. In the monitor's settings, set who is alerted. 🚧 Record here who that is.
- **Planned downtime:** a restart or deploy fits in the five-minute margin. For anything longer, mute the monitor in Sentry first (Crons → the monitor → Mute) and unmute it after, or you'll be alerted.
- **Triage an error:**
  1. Open the issue and read the stack, the tags and the user. The user is their ID, so you can find what they did in the logs (see [Moderation](#moderation)).
  2. Check the breadcrumbs: recent access changes and device actions leave notes there.
  3. Decide: a bug in Pixel (open a GitHub issue, link the Sentry issue), a problem outside it (SpaceAPI, Home Assistant, Discord: see [Incidents](#incidents)), or noise (resolve or ignore it).
  4. If it's urgent and recent, roll back (see [Deploys](#deploys)).
- **Read feedback:** Sentry → **User Feedback**. Each has the sender's Discord name and ID, so you can reply in Discord.
- Errors from before a release can be filtered by the `release` tag, which is the git SHA.

## Privacy requests

> **Draft.** The privacy notice and retention policy (#7) aren't written yet. This section lists where personal data lives so a request can be handled now, and should be revised when #7 lands.

Under GDPR, someone can ask what Pixel holds about them, or ask for it to be deleted. You have **one month** to respond, so note the date you received the request. First confirm who is asking: the person must be the one whose ID it is.

**Where personal data is:**

| Where | What | How long |
| --- | --- | --- |
| `members.yaml` | ID, tier, any note, capabilities | Until removed |
| `data/schedules.yaml` | Creator ID and name, channel, scheduled message or poll text | Until the schedule is deleted |
| Pixel's log file and console | ID, display name, handle, and what they did (commands, outcomes) | The log file keeps about two weeks. Azure Log Analytics for `dev` keeps 30 days (provisional until #7) |
| Sentry (errors, Logs, User Feedback) | The same, plus any feedback they sent | Sentry's retention for the project 🚧 (write it down) |
| Discord | Everything Discord itself holds | Not Pixel's data: refer them to Discord |

Pixel has no database. Message content and command arguments are never logged, except a `/feedback` message, which goes to Sentry as feedback.

**Access request ("what do you have on me?"):**

1. `/admin level get user:<person>` for their tier, note and capabilities, or read their entry in `members.yaml`.
2. Search `data/schedules.yaml` for their ID (`createdBy.ref`) and list those schedules.
3. Search the logs by their ID (see [Moderation](#moderation)).
4. In Sentry, search Issues, Logs and User Feedback for their ID.
5. Send them a copy of what you found, and no one else's data.

**Deletion request:**

1. Remove their entry from `members.yaml` by hand (and `admins.yaml`, if they were an admin), then `/admin reload`. Keep the entry's removal out of any shared notes: don't write their name in the record.
2. Delete their scheduled posts (`/schedule delete`, or remove those entries from `data/schedules.yaml` and restart).
3. Logs: the file ages out within about two weeks. If it must be sooner, remove their lines from the log files (and from any host or platform logs). 🚧
4. Sentry: delete their events, logs and feedback using Sentry's data deletion tools.
5. Tell them what was removed and what was not (for example Discord's own data), and when the remainder will age out.

## Disaster recovery

**What to back up:** `config/admins.yaml`, `config/members.yaml` (it changes at runtime, so it needs regular snapshots; `members.yaml.bak` is only the previous copy), `config/home-assistant/devices.yaml`, and the values of the secrets. `data/schedules.yaml` (the scheduled posts). Not needed: the rest of `data/` (state and logs, safe to delete), `inventory.yaml` (Pixel rebuilds it), `dist/` and `node_modules/`. The code is in git, and `content/` (the `/info` topics) is in the image.

**Rebuild from scratch (today):**

1. Get the code at the version you want: `git checkout <sha>`.
2. Recreate `.env` from the secret store (`DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `HOME_ASSISTANT_*`, `SENTRY_DSN`, the channel and role IDs). If the Discord application is gone, make a new one in the Developer Portal, invite the bot with the permissions it needs, and update the IDs.
3. Restore `admins.yaml`, `members.yaml` and `devices.yaml` from backup, then `just validate-config`.
4. `just register`, then start Pixel.
5. Check `/ping`, `/admin status` and `/ha list`. Run `/admin sync` if roles are mirrored.

If `members.yaml` is lost and there's no backup, Pixel won't start (it fails closed). Restore the last backup, or rebuild the file from `members.example.yaml` and re-add people with `/admin level set` once an admin can start it.

**Bootstrap state:** the storage account `pixelbartfstate` has versioning and 14-day soft delete. Restore a previous `terraform.tfstate` blob if remote state is damaged. If bootstrap was never migrated off the laptop, that local file is the backup — migrate it.

**Azure app (`dev`):** recreate with `just tf-apply dev` after bootstrap exists (the resource group is already there). Restore Key Vault secret values from wherever you keep them (they are not in Terraform state; re-apply with `write_secrets` or `az keyvault secret set`). Restore `members.yaml` / HA files / `schedules.yaml` from Azure Backup of the file share (14 days) or a copy you kept. Practise this in `dev`. Prod is #12.

## Keeping this up to date

- **Change infrastructure, change this file.** A pull request that changes how Pixel is built, configured, deployed or monitored must update the matching section here (and `architecture.md`). This is noted in `AGENTS.md`.
- **When Terraform lands:** search for `🚧` and replace each one with real steps, keeping the "Today" steps only where they still apply. Add the real environment names, links and the on-call contact to "Who and what".
- **Every procedure should be followed once by someone other than its author, in dev,** before it's trusted. Fix whatever they trip over, and note the date here if you like.
- **After an incident,** add what you learned: a missing step, a better check, a new entry under [Incidents](#incidents).
