# Operations runbook

How to run Pixel day to day and what to do when something goes wrong. It is written for volunteers: anyone with the right access should be able to follow it without the original author.

**This is a living document.** Bootstrap (#8) is applied. Container App `pixel-dev` is live (#9). `infra/envs/prod` is in repo (#12). CD: `just deploy dev` or the Deploy dev workflow (a branch or PR) rolls Azure `dev`; merges to `main` publish GHCR when image paths changed. Prod and the docs site ship from the Release workflow. Every procedure has two parts:

- **Today:** what works now, with Pixel run locally or in a container you start yourself. Everything here has been checked against the code.
- **🚧 Azure:** a marker for the steps that still depend on hosting that is not applied, or on #12. Search for `🚧` to find what's left.

Before you change anything on **prod**, read "Rules of thumb" below.

## Contents

- [Rules of thumb](#rules-of-thumb)
- [Who and what](#who-and-what)
- [Quick reference](#quick-reference)
- [Infra overview](infra.md) (diagrams)
- [Running Pixel today](#running-pixel-today)
- [Adding Pixel to a Discord server](#adding-pixel-to-a-discord-server)
- [Access lists](#access-lists)
- [Moderation](#moderation)
- [Home Assistant](#home-assistant) (setup and threat model: [`home-assistant.md`](home-assistant.md))
- [OpenR doors and the gate](#openr-doors-and-the-gate)
- [Terraform bootstrap](#terraform-bootstrap)
- [Azure Container App (`dev`)](#azure-container-app-dev)
- [Closing-time](#closing-time)
- [Mastodon](#mastodon)
- [Space state](#space-state)
- [Secrets](#secrets) ([sync with Key Vault](#sync-secrets-with-key-vault), [pull and push an environment](#pull-and-push-an-environment))
- [Deploys](#deploys)
- [CI and CD](#ci-and-cd)
- [Changelog and versions](#changelog-and-versions)
- [Incidents](#incidents)
- [Sentry](#sentry)
- [Privacy requests](#privacy-requests) ([privacy notice](privacy.md))
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
| **Environments** | `dev` (Pixel Dev bot, test guild) and `prod` (production Pixel bot, production guild). Separate bots, tokens and secrets. Never copy the Dev token into prod. |
| **Who is on the hook when the bot is down** | 🚧 Not decided. Put a named contact (and a backup) here, and where to reach them. |
| **Where Pixel runs** | Azure `pixel-dev` (one replica, no public ingress) plus `pixel-prod` after a maintainer apply, plus any laptop `just dev`. Subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`, West Europe. Resource groups `pixel-bootstrap`, `pixel-dev`, `pixel-prod`. `just deploy dev` rolls `pixel-dev`. **Do not** also run `just dev` on the Pixel Dev token while that app is up. A Release rolls `pixel-prod` after Environment `prod` approval. Diagrams: [`infra.md`](infra.md). |
| **Where the code and CI are** | GitHub, `pixelbar/pixel`. CI runs `just check` and/or a Docker smoke build only when those paths changed ([`dorny/paths-filter`](https://github.com/dorny/paths-filter)). Docs PRs run Biome + the site build. CD on `main` publishes `ghcr.io/pixelbar/pixel:<sha>` when image paths changed. |
| **Access you may need** | The Discord Developer Portal (bot token), a Discord role that can manage the server, the Sentry project, the GitHub repo, the Home Assistant admin account, Owner on the Pixel Azure subscription (to apply bootstrap), and the host. |

## Quick reference

Admin tasks in Discord are in one private panel, `/admin`. This runbook writes them as a path: `/admin` → Doors → **Switch door control off…** means run `/admin`, pick **Doors** in its **Go to…** menu, then press that button. Changes that are hard to undo ask first.

| I want to… | Do this |
| --- | --- |
| See when Pixel last started, crashed or stopped, and which version | The announcements channel: a "🟢 Pixel is online" post per run (version, commit, **Where** `local` or `cloud`), edited to "🔴 offline" on shutdown, or marked "⚠️ stopped unexpectedly" after a crash |
| See if Pixel is up and which version | `/ping` in Discord, or `/admin` (version, **Where** `local` or `cloud`, Node, uptime, access list counts, Discord roles, Home Assistant) |
| Check readiness from outside | `GET /healthz` (process is up) and `GET /readyz` (200 only while the Discord gateway is connected, otherwise 503), on `HEALTH_PORT` (default 8080) |
| Read the logs | Console, or the file `data/logs/current.log` (JSON lines, about two weeks kept), or **Logs** in Sentry |
| See what Pixel stores about people | [Privacy notice](privacy.md). Handle a request under [Privacy requests](#privacy-requests) |
| Set up Home Assistant on a test instance | [`home-assistant.md`](home-assistant.md) |
| A door action looks wrong | [If a door action looks wrong](#if-a-door-action-looks-wrong) |
| Re-read the access lists and devices after a hand edit | `/admin` → **Reload the access lists** (admins only). Or restart |
| Check the config files without starting Pixel | `just validate-config` (the local bot's), or `just validate-config dev\|prod` (that environment's, as `just pull` wrote them) |
| Make Discord pick up new or changed commands | Prod: a Release does it (the `register-prod` job, after a second Environment `prod` approval). Dev: `just deploy dev` or the Deploy dev workflow does it. By hand (rollbacks, or before `github_register_principal_id` is applied): `just register dev` or `just register prod`. Prod uses `.env.prod` (`PIXEL_ENV=prod`), never the Mini Pixel Dev token |
| Add Pixel to a Discord server | [Adding Pixel to a Discord server](#adding-pixel-to-a-discord-server) |
| Turn closing-time posts on or off, or change the text | [Closing-time](#closing-time) |
| Change the top pages `/wiki` shows | Edit the links on the wiki's [Main Page](https://wiki.pixelbar.nl/Main_Page): `/wiki` offers the pages it links to, by title. Pixel picks up a change within 15 minutes. Nothing to restart |
| Look up a person | `/admin` → People → **Look someone up…** (admins only) |
| See what changed between versions | [`CHANGELOG.md`](../CHANGELOG.md) |
| Cut a production release | GitHub → Actions → **Release** → Run workflow on `main` |

Useful `just` recipes: `just dev`, `just check`, `just validate-config`, `just check-changelog`, `just bump`, `just register dev`, `just register prod`, `just sentry-release`, `just command-access dev`, `just docker-build`, `just deploy dev`, `just deploy-remote dev`, `just tf-validate`, `just tf-plan prod`, `just env dev`. Run `just` to list them all, grouped by what they act on. Every recipe that takes `dev` or `prod` gets that environment's Azure names, env file and guards from [`scripts/envs.ts`](../scripts/envs.ts); `just env dev` (or `prod`) prints them. `just deploy-dev` still works as the old name for `just deploy dev`.

## Running Pixel today

**Azure `dev` is live** (`pixel-dev`, one replica). Prefer `just deploy dev` for that bot. If `pixel-dev` is up, do **not** also `just dev` on the same Pixel Dev token (two bots would both answer).

To run Pixel from a laptop (your own bot, or the Pixel Dev bot only when the Azure app is stopped):

**From source** (needs Node.js and pnpm):

```sh
just install
cp .env.example .env            # then fill in the values
cp config/admins.example.yaml config/admins.yaml     # then edit both files
cp config/members.example.yaml config/members.yaml
just validate-config            # must say OK
just register dev               # once, and after command changes; prod: just register prod
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

Mount the **config directory writable**: `members.yaml` is changed by admin commands (written to a temp file next to it, then renamed, with the previous copy kept as `members.yaml.bak`). `data/` holds state and the log files. **`data/schedules.yaml` and the three `data/parking-*.yaml` files are not safe to delete** (the scheduled posts, and the parking spots, today's opening times and who is parked). Nor is `data/attendance.yaml` while an attendance poll is open (its votes). The rest of `data/` is. See [`architecture.md`](architecture.md) for every setting.

Only ever run one copy. Before starting one: `docker ps`, and check nobody else has Pixel running with the same token.

**Azure (`dev`, after apply):** Container App `pixel-dev` in resource group `pixel-dev`. Secrets from Key Vault `pixel-dev-kv`. `admins.yaml` is a read-only Key Vault file. `members.yaml`, Home Assistant files and `data/` (including `schedules.yaml`) live on Azure Files share `pixel` on account `pixeldevdata`, mounted at `/app/persist`. How to apply, seed files, and restart: [Azure Container App (`dev`)](#azure-container-app-dev). Do not start a local Pixel on the same token while that app is up.

## Adding Pixel to a Discord server

Pixel serves **one guild per bot**. `DISCORD_GUILD_ID` is that guild. The running process leaves every other server (`discord.foreign_guild`). Dev (Pixel Dev) stays on the test guild. Prod is a **separate Discord application** in its own guild. Do not invite Pixel Dev into the production server and expect it to stay.

The URL `just command-access` prints is **not** an invite. It is user OAuth (`applications.commands.permissions.update` only) so admins can see `/admin`. Authorising it never adds a bot member. See [`discord-command-visibility.md`](discord-command-visibility.md).

**Invite (prod or a new test bot):**

1. Developer Portal → the right application (prod is not Pixel Dev) → **Bot**. Public Bot as you need it. **Require OAuth2 Code Grant** off. Guild install, not user install.
2. OAuth2 → URL Generator: scopes **`bot`** and **`applications.commands`**. Permissions to request: View Channel, Send Messages, Embed Links, Read Message History, plus Send Polls if you use `/schedule`, plus Manage Roles only if you set `DISCORD_ROLE_MEMBER` / `DISCORD_ROLE_FRIEND`. With `DISCORD_ROLE_SYNC=on`, also turn on **Server Members Intent** under Bot → Privileged Gateway Intents (for each bot: Pixel Dev and prod). Open the URL, pick the server (you need Manage Server), authorise. Confirm the bot is in **Members**.
3. Put that application ID in `DISCORD_APP_ID` and the server ID in `DISCORD_GUILD_ID` (gitignored `.env` for local, gitignored `terraform.tfvars` for Azure). Channel IDs must be in **this** guild.
4. `just register dev` or `just register prod` against that env’s token and guild. Optional: add redirect `http://localhost:53682/callback`, then `just command-access` for the same env.
5. Start **one** instance. Never two processes on one token.

Shape: `https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot%20applications.commands&permissions=<bits>`. No `response_type` or `redirect_uri` on a bot invite.

## Access lists

Tiers come from two files: `config/admins.yaml` (hand-edited) and `config/members.yaml` (changed by admin commands, and safe to edit by hand). Read [`identity-and-access.md`](identity-and-access.md) before changing either.

**Add or change a member or friend (the normal way):**

1. In Discord, an admin runs `/admin` → People → **Change level…** with an optional reason.
2. Check it with `/admin` → People → **Look someone up…**.

That's all: Pixel updates `members.yaml` itself (writing the person's Discord username as the `note` if the entry has none, so you can tell who is who; it never replaces a note you wrote), keeps `members.yaml.bak`, and logs an `access.changed` event with who did it. If Pixel is configured to mirror Discord roles, it also sets the person's role. `/admin` → Discord roles → **Sync everyone** re-applies the roles for everyone if they ever drift.

**Role sync (optional).** With `DISCORD_ROLE_SYNC=on`, Pixel also works the other way: every minute it reads who holds the mapped roles and updates `members.yaml` (role given → that level; role taken away or left the server → guest; admins never change). Giving someone the `member` role in Discord is then enough. To turn it on: enable the Server Members Intent for the bot (Developer Portal → Bot), run `/admin` → Discord roles → **Sync everyone** so everyone Pixel lists holds their role, then set `DISCORD_ROLE_SYNC=on` (`discord_role_sync = "on"` in the env's `terraform.tfvars` on Azure) and restart. Look for `role_sync.problem` in the logs or Sentry: it says why the sync paused (a broken role, the intent off) or that it held back more than 5 removals at once; fix the roles or run `/admin` → Discord roles → **Sync everyone**, and it carries on by itself. Each change is an `access.changed` record by the bot, with reason "Has the member role" or "Discord role removed".

**Remove someone completely:** `/admin` → People → **Change level…** keeps their entry. To delete the entry, edit `members.yaml` by hand (remove the whole `- ids: …` block), then `/admin` → **Reload the access lists**. Admins can't be changed from Discord (see below).

**Add or remove an admin:** admins are never changed from Discord. Edit `config/admins.yaml` by hand, and make sure every admin also has an entry in `members.yaml` with the same IDs. Then run `just validate-config` and `/admin` → **Reload the access lists** (or restart). Admin IDs must be quoted strings like `"discord:123456789012345678"`. Getting an ID: in Discord, enable Developer Mode, right-click the person, **Copy User ID**.

**If you edited a file and Pixel won't start:** run `just validate-config`. It names the file, the position and the field, never the value. Fix that and start again. A bad `admins.yaml` or a missing admin list is a startup failure by design. `members.yaml.bak` is the previous good copy if you need to go back.

**Capabilities** (extra permissions such as `ha-lights`): `/admin` → People → **Grant capabilities…**, `/admin` → People → **Grant every capability…** (every capability in one audited change) and `/admin` → Capabilities. To give one to everyone at a level, use `/admin` → Capabilities → **What friends get** / **What members get** (`level:friend` reaches friends and members) and `revoke-level` to take it back; it is saved in the `tiers:` section at the top of `members.yaml`, and a hand edit there needs `/admin` → **Reload the access lists** like any other. They only ever work for members, friends and admins, never guests. A real individual grant or revoke also DMs the person, naming the capability; a level change DMs nobody. If they have DMs from server members closed, the change still applies; look for `capability.dm_failed` in the logs (IDs, not the message text).

**Azure (`dev`):**

- **`admins.yaml`:** Key Vault secret `admins-yaml`, mounted read-only. `just secrets-pull dev` writes it to `config/admins.dev.yaml`; edit that, then `just secrets-push dev`, which checks it against the env's `members.yaml` and offers the restart (see [Sync secrets with Key Vault](#sync-secrets-with-key-vault)). Versions of the secret are history.
- **`members.yaml` and Home Assistant files:** on the Azure Files share. Admin commands already rewrite `members.yaml` in place. A hand edit of `members.yaml` (or any file on the share): `just pull dev`, edit `config/dev/members.yaml`, `just push dev` (see [Pull and push an environment](#pull-and-push-an-environment)), then `/admin` → **Reload the access lists**, or restart. Daily backups of the share keep 14 days.
- Prod (#12) will be the same layout in `pixel-prod`.

## Moderation

**Find what someone did.** Pixel logs every command, denial and rate limit with the person's stable ID. Search by ID, never by name:

```sh
# from the log file (JSON lines): what did discord:123456789012345678 do?
jq -c 'select(.user == "discord:123456789012345678")
       | {time: (.time/1000|todate), event, command, outcome, reason, msg}' data/logs/*.log
```

The events to look for: `command.executed` (with `outcome`), `command.denied`, `command.rate_limited`, `access.changed` (from Pixel, or from `just push` with `source: just-push` and an `azure:` user), and for Home Assistant `home.action` and `home.action_denied`. In Sentry, open **Logs** and filter on the `user` attribute (`discord:<id>`), or look at the issue's user. The names in the logs (`userName`, `userHandle`) are there so you can recognise the person, but act on the ID.

**Stop someone using Pixel.** Pixel has no block list of its own (#6 decided Discord's own moderation covers it):

1. **Ban or time them out in Discord** (Server Settings → Members). A banned person can't use any command.
2. If they were a member or friend, run `/admin` → People → **Change level…**, and revoke any capabilities with `/admin` → People → **Revoke capabilities…**, so nothing lingers if they come back.
3. Note what you did and why.

If you suspect someone's **account was taken over** (for example it is unlocking things or running device actions it never used to), do 1 and 2 at once, then check the logs for what it did, and tell the board.

## Home Assistant

First-time setup (dedicated non-admin user, token, URL, devices file) and the threat model: [`home-assistant.md`](home-assistant.md). Why those choices: [ADR 0011](adr/0011-home-assistant.md).

Pixel talks to Home Assistant (HA) with a long-lived token from a **non-admin** HA user, and can only touch the devices in `config/home-assistant/devices.yaml` (read [`architecture.md`](architecture.md), "Home Assistant"). `/admin` shows whether it's connected, and how many devices are allowed.

**Add or remove devices on Azure:** `just ha-devices dev` (or `prod`). It pulls that env's `devices.yaml` from the file share, shows everything Home Assistant has with what's already listed ticked (marked `[listed as …]`, first). Tick to add a device, untick to remove one. Press `/` to search, ⏎ to keep the filter, `s` to see every ticked device, and esc to go back; ticks survive searches. Listed devices Home Assistant no longer offers are shown too, so they can be removed. For each new device it asks: the name, the actions (none means read-only) and `minTier`. It validates the result, shows the diff, and uploads it only when you say yes and nobody changed the remote meanwhile. Then run `/admin` → **Reload the access lists** in that env. The remote is the truth: the tool keeps a local copy in `config/home-assistant/<env>/devices.yaml`, and if that copy has edits the remote lacks, it shows them and stops (or throws them away if you say so). It needs `az login` and `HOME_ASSISTANT_URL` / `HOME_ASSISTANT_TOKEN` in `.env.dev` (or `.env`) or `.env.prod`. Doors start with no actions ticked, and on dev it offers none, because dev must not control the real doors. A leftover `inventory.yaml` on a share (older Pixel versions wrote it) is not used and can be deleted.

**Add a device by hand:** write an entry in `devices.yaml` (the entity ID is on the entity's page in Home Assistant), and set who may use it (`minTier`) and which `actions` are allowed (none means read-only). Run `just validate-config`, then `/admin` → **Reload the access lists**: the reply says how many devices there are and warns about entities HA doesn't know. Nothing is usable until it's in `devices.yaml`.

**Take a device away from people quickly:** remove its `actions` (or the whole entry) from `devices.yaml` and `/admin` → **Reload the access lists**. Changing it back is the same in reverse.

**Doors:** members with `ha-doors` (or `ha-admin`) can lock or unlock a door with the **Lock** and **Unlock** buttons on its panel in `/ha` (`/ha device:` goes straight to it). Pixel never unlatches (`open` / `lock.open`); drop `open` from `devices.yaml` if it's still listed, or `just validate-config` refuses the file. A door can't be opened to friends: `just validate-config` refuses a door with `minTier: friend`.

**Stop all door control at once:** `/admin` → Doors → **Switch door control off…** (admins only). Nobody can then act on any door from Pixel until an admin runs `/admin` → Doors → **Switch door control on**. It survives restarts. Check it in `/admin`. If the switch file in `data/` is ever unreadable, doors start off and say so in the logs; `/admin` → Doors → **Switch door control on** fixes it.

**Emergency stop for everything:** revoke Pixel's token **in Home Assistant** (profile of the Pixel user → Security → Long-lived access tokens → delete). Pixel's next call is refused and the connection turns off. It takes effect at once and doesn't depend on Pixel being healthy. To bring it back, make a new token and put it in `HOME_ASSISTANT_TOKEN` (see [Secrets](#secrets)).

### If a door action looks wrong

Someone unlocked (or locked) a door who shouldn't have, a door moved when nobody asked, or `/ha` reported a result that doesn't match the physical door.

1. **Stop Pixel's door control now:** `/admin` → Doors → **Switch door control off…**. That is enough if the problem is only Pixel. It does not lock the physical door.
2. **If anything still moves,** or you don't trust the Home Assistant user: delete Pixel's long-lived token in HA (emergency stop above). That stops every Pixel action, not only doors.
3. **Check the physical door** and, if you can, Home Assistant's own logbook for that lock.
4. **Find who Pixel thinks did it.** Search the logs for `"kind":"door"` and `home.action` / `home.action_denied` (see [Moderation](#moderation)). Act on the Discord ID, never the name. A matching nickname is not evidence.
5. **If that Discord account looks taken over:** Discord ban or timeout, `/admin` → People → **Change level…** to guest, revoke `ha-doors` and `ha-admin` (see [Moderation](#moderation)). Keep doors off until you know they can't do it again.
6. **If the token or the HA admin looks leaked:** rotate the Home Assistant token (and the HA admin password) as in [Secrets](#secrets). Treat a leaked HA admin as a building incident, not only a Pixel one.
7. Tell the board what you stopped, which ID you found, and whether the physical door was open.

**If Home Assistant is unreachable:** see [Incidents](#incidents).

**How Pixel reaches HA:** locally, `HOME_ASSISTANT_URL` is usually the Nabu Casa cloud URL. On Azure the preferred path is a Tailscale sidecar so the container talks to HA on the LAN (#9, #43). A Nabu Casa URL still works if the sidecar is not there yet.

## Terraform bootstrap

`infra/bootstrap` (#8) is applied. It does **not** run Pixel. It created remote Terraform state and GitHub → Azure login without a client secret.

**Who can apply:** Owner on subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`. Later changes: [`infra/bootstrap/README.md`](../infra/bootstrap/README.md).

**GitHub Environment `prod`** (reviewers, branch `main`) needs `ARM_CLIENT_ID`, `ARM_TENANT_ID` and `ARM_SUBSCRIPTION_ID` as **variables**, not secrets. Values: [`infra/bootstrap/README.md`](../infra/bootstrap/README.md). Azure `dev` uses local `az` (`just tf-apply dev`, `just deploy dev`), or Environment `dev` `ARM_*` for the Deploy dev workflow. Terraform plan on PRs uses Environment `dev` / `prod` `ARM_*` and **fails closed** if they are missing. The prod plan runs with `-refresh=false`: GitHub is not Key Vault Secrets User on `pixel-prod-kv` (ADR 0012; since ADR 0014 it may read the `discord-token` secret only), so refreshing the other secrets in state would fail with 403. It plans with the example tfvars, so it shows the Key Vault secrets being removed; that is expected and it never applies. Before applying prod, run `just tf-plan prod` locally for the real plan. Coding agents must not apply prod.

**Do not** apply bootstrap from GitHub Actions, and do not run a second Pixel bot against the same Discord token.

## Azure Container App (`dev`)

Terraform: `infra/modules/pixel` + `infra/envs/dev` (#9). **Do not apply until a maintainer says so.** Steps, secret names, volume layout and tear-down: [`infra/envs/dev/README.md`](../infra/envs/dev/README.md).

```sh
just tf-validate
just tf-plan dev
just tf-apply dev    # only when told; does not roll the running image
```

The first apply after #73 **moves** the Container App address (`azurerm_container_app.this` → `this[0]`). That is not a replace and does not change the running image. Plan should say "has moved", not destroy/create.

After apply, Discord still will not answer until Key Vault secrets exist (app secrets with `just secrets-push dev`; Terraform never writes them, [ADR 0017](adr/0017-one-writer-for-app-secrets.md)), `members.yaml` is on the share, an image exists, commands are registered, and nothing else is using that bot token.

**On `dev`, the image is owned by `just deploy dev`, not by apply** ([#73](https://github.com/pixelbar/pixel/issues/73), [ADR 0010](adr/0010-ghcr-cd.md)). First create uses `container_image` (default `:main`). After that, Terraform **ignores** the Pixel container image on the **dev** app only. A later `just tf-apply dev` still updates vault, volume, env and the replica pin; it does **not** roll the bot back to a stale SHA in gitignored `terraform.tfvars`. Do not apply Terraform from CD to "fix" that drift. Do not bump `container_image` expecting a **dev** apply to change what is running.

**Prod** is `azurerm_container_app.managed`: apply **will** set `container_image`. Do not copy the dev ignore onto prod. Coding agents must not apply prod (`PIXEL_APPLY_PROD=1`).

- **Change the running `dev` image:** `just deploy dev`, the Deploy dev workflow, or `az containerapp update -g pixel-dev -n pixel-dev --image ghcr.io/pixelbar/pixel:<sha> --min-replicas 1 --max-replicas 1`.
- **See what is running:** `az containerapp show -g pixel-dev -n pixel-dev --query "properties.template.containers[0].image" -o tsv`
- Keep min=max replicas = 1.

**Restart the app** (after rotating a secret or changing `admins.yaml`):

```sh
just restart dev
```

That restarts the running revision (`az containerapp revision restart`); it doesn't deploy anything. `just restart prod` does the same for `pixel-prod`.

**See that there is exactly one replica:** `az containerapp replica list -g pixel-dev -n pixel-dev -o table`. If a command is answered twice, stop the extra instance (a laptop, or an old revision). Never raise `max_replicas`. Overlap during a deploy is #11.

**Home Assistant:** Tailscale sidecar is preferred (`tailscale_enabled = true` plus Key Vault `tailscale-auth-key`). A Nabu Casa URL in `home_assistant_url` plus `home-assistant-token` still works when Tailscale is off. Set both URL and token, or neither. Dev must not point at the real doors.

**Rough cost:** about €40–55/month for always-on `dev` without Tailscale, plus about €15 with the sidecar. West Europe. Not a quote.

**Prod** (`infra/envs/prod`, #12): a maintainer applies with `PIXEL_APPLY_PROD=1 just tf-apply prod` after a **separate** Discord application, prod Key Vault secrets, and access lists exist. Coding agents must not apply prod. `just deploy dev` still rolls only `pixel-dev`. Merges to `main` publish GHCR only. A [Release](../.github/workflows/release.yml) cuts the version and, after Environment `prod` approval, rolls `pixel-prod` (`az`, min=max=1, no Terraform apply). The Release then registers prod commands (ADR 0014) once a maintainer has applied `github_register_principal_id`; until then, `just register prod` (`.env.prod`), never the Mini Pixel Dev token. Steps: [`infra/envs/prod/README.md`](../infra/envs/prod/README.md).

## Scheduled posts

Members with the `schedule-posts` capability schedule messages, polls and attendance polls with `/schedule` (`/admin` → People → **Grant capabilities…**). `/schedule` opens a private panel that lists them all; who made each is in the file.

After a deploy that adds `/schedule`, run **`just register dev`** or **`just register prod`** so Discord lists the commands, then grant the capability. No new environment variables: times use `PIXEL_TIMEZONE` (Europe/Amsterdam). The bot needs Send Messages in the target channel, and Send Polls if it will post native polls (attendance polls don't need it).

- **They live in `data/schedules.yaml`.** Back it up with the access files; deleting it deletes every schedule.
- **Tokens** in the message, poll question or answers (`{{date}}`, `{{day}}`, `{{month}}`, `{{year}}`, `{{dateWithTime}}`) fill in when the post goes out, in `PIXEL_TIMEZONE`. A whole-day offset (`{{date+2}}`, `{{day+2}}`) is from the scheduled day, so a Monday post can say Wednesday. A name Pixel doesn't know is left as written. Discord's limits (2000 characters for a message, 300 for a poll question, 55 for an answer) count the filled text, so `/schedule` refuses a post its tokens would push over. `schedule.clipped` in the logs means one still came out too long and was cut to fit. Don't put secrets in a scheduled post.
- **Change one before it posts:** pick it in `/schedule` and press **Edit** (only the person who scheduled it sees Edit, Pause and Delete). Nothing changes until they press **Save changes**.
- **Stop one now:** the person who made it presses **Pause** or **Delete** on it in `/schedule`. Nobody else can, admins included: to stop someone's schedules, revoke their capability (each of theirs pauses the next time it's due), or remove the entry from `data/schedules.yaml` and restart.
- **Poll reminders:** a poll with a reminder (set with **Reminders** on its draft) gets a daily reminder in that channel while it's open, linking to it. `schedule.reminded` in the logs means one went out; `schedule.reminder_failed` (Pixel can't post in the reminder channel) and `schedule.reminder_skipped` (more than an hour late) mean it didn't. To stop them, its creator edits the poll and clears the time in **Reminders**, or pauses it.
- **Attendance polls** ("who's coming", [ADR 0025](adr/0025-attendance-poll-buttons.md)): **New attendance poll** in `/schedule`. Pixel posts a message with a button per answer and counts the clicks itself, so there's no "winner". Anyone in the server can press one (once: another switches, the same one again takes it back), and the message shows each answer's total and who picked it. On the draft, choose which answers count as coming, and with **Results** a channel for the totals: the totals so far at a time on the day it closes (say `17:00` for a poll open until midnight), and the closing totals when it closes. Their wording is the creator's, with `{{count}}`, `{{names}}`, `{{question}}`, `{{link}}` and the date tokens. The buttons keep working across deploys and restarts, and go when the poll closes.
  - **The votes live in `data/attendance.yaml`.** Back it up with `schedules.yaml`. Deleting it while a poll is open loses that poll's votes, and its buttons then say "That poll isn't running any more." Closed polls drop out a week after they close. If it's invalid (a bad hand edit), no votes are taken and no attendance poll is posted until it's fixed (`attendance.unreadable` in the logs), and Pixel never overwrites it.
  - **Results didn't go out:** look for `attendance.results_skipped` (Pixel was down more than an hour past the time), `attendance.results_no_access` (the creator lost `schedule-posts`) or `attendance.failed` (Pixel can't post in the results channel). `attendance.refresh_failed` means the totals on the poll couldn't be updated (permissions, or the message was deleted); the next click tries again, and for a poll that has closed Pixel keeps trying to take its buttons away every 30 seconds for a day. A poll that's already out keeps its results settings even if the schedule is edited or deleted.
- **"That's expired. Run the command again."** The panel's buttons last 15 minutes from the last click, and a deploy or restart drops them and any unsaved draft. Nothing that was saved is lost.
- **A post didn't go out:** look in the logs for `schedule.failed` (Pixel can't post there any more: permissions, a deleted channel), `schedule.skipped` (Pixel was down more than an hour past the time) or `schedule.paused_no_access`. Pixel never retries a failed post; the next occurrence tries again.
- **If the file is invalid** (a bad hand edit), nothing is posted or changed, and `/schedule` says so. Fix it or restore it from backup, then restart. Pixel never overwrites it while it's invalid.

## Parking

Members with the `parking` capability use `/park` (`/admin` → People → **Grant capabilities…**): a private panel that shows who's parked where, gets them a spot and opens the gate, and has Leave, Stay longer and Someone's in my spot once they're parked. `/park for:` books straight away. Admins manage the spots and when they're open with `/admin` → Parking. After deploying a version that adds these commands, run `just register dev` or `just register prod`. With [OpenR](#openr-doors-and-the-gate) set up and `OPENR_GATE_DOOR` set, `/park` opens the gate; without it, or while Pixel is logged out of OpenR or `/admin` → Doors is off, `/park` says to open it the usual way.

| I want to… | Do this |
| --- | --- |
| Add our own spot | `/admin` → Parking → **Add a spot**, kind **Permanent**. A permanent spot is open every day until the reset |
| Add a borrowed spot | `/admin` → Parking → **Add a spot**, kind **Borrowed**. It's closed until it's opened |
| Open borrowed spots for today | `/admin` → Parking → **Open spots…**, pick them, then fill in the form: **From** defaults to now and **Until** to the reset. Opening a spot again replaces that day's opening; a **From** of `tomorrow 8` sets tomorrow's |
| Close a spot | `/admin` → Parking → **Close spots…** ends a borrowed spot's opening for today. For our own spot, Pixel asks until when (default: the reset); **Open again** on its panel lifts the closure |
| See what's open | `/admin` → Parking |
| Change the reminder, grace period, reset or durations | `/admin` → Parking → **Settings** (the panel shows them) |
| Free a spot someone left without pressing **Leave** in `/park` | `/admin` → Parking → pick the spot → **Free the spot…** |
| Watch parking | Set `DISCORD_PARKING_CHANNEL_ID` to a private admin channel (local `.env`; on Azure, `discord_parking_channel_id` in that env's `terraform.tfvars`, then apply). Pixel posts every booking, leave, extension, ending, taken-spot report and admin change there. The bot needs View Channel and Send Messages. `parking.channel_failed` in the logs means a post didn't go through |
| See how much parking is used | Sentry, Explore → Metrics: `pixel.parking`, split by `event` (and `spot`). Counted whether or not the channel is set |
| Someone reported a spot taken | The parking channel says who and which spot. That spot is closed until the reset (`/admin` → Parking shows "reported taken"). If you find who parked there, **Give it to someone…** on that spot in `/admin` → Parking gives them that spot (and lifts the closure). Pixel won't take it from someone still booked into it: they press **Someone's in my spot** in `/park` to get a new spot, or you go ahead when Pixel asks, which ends their booking. Otherwise, once it's clear, opening it in `/admin` → Parking opens it again. If nothing else was free, Pixel asked the reporter to leave and ended their booking |
| Close or remove a spot someone's parked in | Pixel says who's there until when and asks; **Go ahead and end it** ends their booking |
| Stop someone parking | Revoke their `parking` capability. A booking they already hold stays until they leave, an admin frees it, or the reset |

- **Nothing runs past the reset** (23:59 by default, in `PIXEL_TIMEZONE`): every booking ends there, and openings and closures end there at the latest and are pruned from the file once they end. If Pixel was down at the reset, it ends those bookings when it starts. Moving the reset earlier shortens what's already set to match.
- **Reminders:** Pixel DMs people `remindMinutes` (15) before their end, and ends a booking `graceMinutes` (5) after it if they haven't left or extended (**Settings** in `/admin` → Parking changes both). People need DMs from server members on. `parking.dm_failed` in the logs says who didn't get one and why (DMs closed, left the server); it never stops a booking ending. A reminder is never sent twice, even across a restart; one missed while Pixel was down isn't sent late once the booking has ended.
- **Who's parked** is in `data/parking-bookings.yaml`. A booking is deleted when it ends. Look for `parking.booked`, `parking.left`, `parking.reset`, `parking.freed` and `parking.evicted` in the logs. `parking.gate_failed` means the gate didn't open (its `reason` is `not-connected`, `off` or `failed`; `openr.open_failed` just before it has OpenR's side): the person keeps their spot and can run `/park` again.
- **If `parking-bookings.yaml` is invalid,** no one can park and `/park` and `/admin` → Parking say so (`parking.bookings_unreadable` in the logs). Fix it, or if you're sure nobody is parked, delete it, then restart.
- **The files:** `data/parking-spots.yaml` (the spots and settings), `data/parking-windows.yaml` (opening times) and `data/parking-bookings.yaml` (who's parked). Back up the spots file with the access files. None is safe to delete: deleting the spots file deletes the spots, deleting the windows file closes every borrowed spot until someone opens it again, and deleting the bookings file frees spots that have cars in them.
- **If `parking-spots.yaml` is invalid** (a bad hand edit), parking is off and `/admin` → Parking refuses changes; its panel and the logs (`parking.spots_unreadable`, and Sentry at startup) say why. Fix the file or restore it from backup, then restart. Pixel never overwrites it while it's invalid.
- **If `parking-windows.yaml` is invalid,** borrowed spots are closed (our own spot still works) and `/admin` → Parking says so. The next open or close moves the broken file aside to `parking-windows.yaml.broken` and starts a new one; set today's openings again.

## Closing-time

Members can post a closing-time reminder with `/closing-time`, and Pixel posts the same message automatically after a confirmed space-closed announcement. Both paths no-op if posting is off.

**After a deploy that adds `/closing-time`, run `just register dev` or `just register prod`** so Discord lists the command.

| I want to… | Do this |
| --- | --- |
| Turn it on | Set `DISCORD_CLOSING_TIME_CHANNEL_ID` to the Discord channel ID (local `.env`; on Azure, `discord_closing_time_channel_id` in that env's `terraform.tfvars`, then apply. Set by hand with `az`, the next apply removes it). The bot needs View Channel, Send Messages and Embed Links there |
| Turn it off | Unset the variable, or set it to `off` or `none`. `/closing-time` then says so privately; the automatic path logs `closing_time.disabled` and does not fail space-close |
| Change the text | `/admin` → Closing time → **Change the message…** (opens a modal, prefilled when a message is already saved). Pixel writes `data/closing-time.md` on the persist volume (Azure Files share on cloud — that write *is* the sync; there is no extra copy). You can still edit the file by hand. A missing or empty file uses a built-in default. No restart needed. `{{date}}` and the other date tokens fill in when it is posted. **Never put door codes, wifi passwords or personal data in it** |
| Change where open/closed is announced | `/admin` → Announcements → **Add a channel…** (a style and a channel), or **Stop announcing in…**; the section lists them. It takes effect at once and is saved in `data/announcement-routes.yaml` on the persist volume. There is no environment setting for this; moving Pixel to another share means copying that file with the rest of `data/`. After deploying a version that adds the command, run `just register dev` / `just register prod`. **Upgrading from `DISCORD_ANNOUNCE_LIVE_CHANNEL_ID` / `DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID`:** those are gone and ignored, so set the same channels again with `/admin` → Announcements → **Add a channel…** right after the deploy, or open/closed announcements stop. A route whose channel was deleted or lost permissions stays on the list with the reason (and is reported to Sentry at startup). Fix the channel's permissions and Pixel picks it up by itself within 5 minutes (log `announcements.route_on`), or `set` it again to check at once |
| See that it posted | The configured channel: a "Closing time" embed, mentions disabled |
| Discord lists `/closing-time` but Pixel says it doesn't know it, or shows an error and then the reminder still posts | Another instance is on this bot token. Stop the extra one (see [Incidents](#incidents)), then retry |

The destination is a channel ID on purpose: do not hard-code a Discord channel in the code.

## Mastodon

Pixel can toot announcements to a configured Mastodon account. It is **outbound only**: it never reads mentions, replies or DMs. Features do not change — they still hand a typed announcement to the announcer. No instance or account is hard-coded.

**Turn it on** (local `.env`, or the Container App env plus Key Vault for the token):

1. On the instance, create an application (Preferences → Development → New application). Name it something like `Pixel`. Scopes: **`write:statuses` only**. Do not enable read, follow or admin scopes.
2. Mark the account as a bot and follow that instance's rules for automated accounts.
3. Set `MASTODON_INSTANCE` to the instance origin (`https://mastodon.example`) and `MASTODON_ACCESS_TOKEN` to the access token. Set both or neither.
4. Optional: `MASTODON_ACCOUNT` (public handle, logs only), `MASTODON_VISIBILITY` (`unlisted` default, or `public` for the local timeline), `MASTODON_ANNOUNCE_KINDS` (default `space.status`; add `closing.time` or `bot.status` if you want those too; `off` / `none` turns toots off).
5. Restart Pixel. A line `publisher ready` with `publisher: mastodon` means it registered. The first confirmed space open or close should appear on the account.

**Turn it off:** unset `MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN` (or set `MASTODON_ANNOUNCE_KINDS` to `off`). Discord is unchanged.

**Emergency stop:** revoke the application token on the instance. The next toot is refused, reported to Sentry (`announcer:mastodon`), and Discord still works.

The token is a secret. Never put an instance URL or handle in the code; never put the token in a chat, an issue or a log.

## OpenR doors and the gate

Pixel opens the building's doors (`/openr open door:`) and the parking gate (`/park`) through OpenR, logged in as **one OpenR account of its own**. OpenR only sees that account; Pixel decides who may open what. Why: [ADR 0022](adr/0022-openr-doors.md). How it works: [`architecture.md`](architecture.md), "OpenR".

**Turn it on:**

1. Get an OpenR account for Pixel that can open the doors you want (and only those, if OpenR lets you choose). Its mailbox gets the login codes, so only admins should read it.
2. Put `OPENR_EMAIL` and `OPENR_PASSWORD` in `.env.<env>` and `just secrets-push <env>` (Key Vault secrets `openr-email` and `openr-password`). Locally, put them in `.env`.
3. Set the building and doors: `openr_building_id`, `openr_doors` (`Entrance=103, Living room=203`: the names people pick, and OpenR's door IDs) and `openr_gate_door` in that env's `terraform.tfvars`, then apply (locally: `OPENR_BUILDING_ID`, `OPENR_DOORS`, `OPENR_GATE_DOOR`). To find the IDs, put the account in the env file and run `just openr-doors <env>`: it logs in (asking for the code OpenR emails), lists the buildings and doors the account can see with their IDs, marks the ones it can open, prints a suggested `OPENR_BUILDING_ID` and `OPENR_DOORS`, and logs out again. It's read-only and leaves Pixel's own session alone. (The IDs are also in the OpenR dashboard's address bar, `/buildings/<building>/doors/<door>`.) Never list the gate in `openr_doors`: only `/park` opens it, and startup refuses it. On **dev**, think twice before setting real doors: dev would open the real building.
4. Restart Pixel, and run `just register dev` (or `prod`) so Discord shows `/openr`.
5. Log in: `/admin` → OpenR → **Log in**. OpenR emails a code to Pixel's account; pass it on with `/admin` → OpenR → **Enter the code…** within 10 minutes. `/admin` → OpenR should say logged in.
6. Grant the capability to the members who may open doors: `/admin` → People → **Grant capabilities…**. Being an admin is not enough. The gate needs only `parking`, and a booking.

| I want to… | Do this |
| --- | --- |
| See whether Pixel can open doors | `/admin` → OpenR: logged in, when the session ends, whether refreshing is failing, and each door's and the gate's live status from OpenR (online or offline, and its errors). `/admin` shows the session only |
| Keep the session going | Nothing day to day: Pixel refreshes it every ~15 minutes. But OpenR ends it about **6 months after the login** whatever Pixel does; `/admin` → OpenR warns two weeks before. Log in again then |
| Log Pixel in again | `/admin` → OpenR → **Log in**, then `/admin` → OpenR → **Enter the code…** with the emailed code. A new login replaces the old session only once the code is accepted |
| Stop every door and the gate now | `/admin` → Doors → **Switch door control off…**. It also stops Home Assistant's doors. `/admin` → Doors → **Switch door control on** to undo |
| Stop Pixel opening anything through OpenR at all | `/admin` → OpenR → **Log out…**: Pixel forgets the session and tells OpenR. Nothing opens until someone logs in again |
| Stop one person | Revoke their `openr` capability (and `parking` for the gate) |
| Add, rename or remove a door | Change `openr_doors` (or `OPENR_DOORS`) and apply, then restart. No re-registering: doors are autocompleted |

- **When the session ends:** OpenR can end it (a refused refresh, a password change, an expiry). Pixel then can't open anything until an admin logs in again: Sentry gets an `openr` error saying so, the logs say `openr.session_ended`, and `/admin` shows it. `/park` still books spots and says to open the gate the usual way.
- **A door shows offline or errors** on `/admin` → OpenR: that's OpenR's own view of the door (its reader or controller), not Pixel's. Check it in the OpenR dashboard. `openr.status_failed` in the logs means the status couldn't be read at all.
- **If OpenR is down:** opening fails at once (`openr.open_failed` with the HTTP status or `timeout`). Pixel keeps the session and keeps refreshing; `openr.refresh_failed` repeats in the logs and Sentry gets the first one. Nothing is retried or opened late.
- **If OpenR starts refusing everything** after working before, OpenR may have changed its dashboard. Pixel copies the dashboard's version header (`APP_VERSION` in `src/adapters/openr/client.ts`); compare it with the version the dashboard sends (browser dev tools, any request's `yy-app-version`) and update it.
- **Logs:** `openr.door_opened` / `openr.door_failed` / `openr.door_denied` (who, which door, why), `parking.gate_opened` / `parking.gate_failed`, and `openr.login_started`, `openr.login_completed`, `openr.logged_out` with the admin. Never the email, password, code or cookies.
- **The session file** `data/openr-session.json` holds the session's cookies: anyone who has it can open the doors until the session ends. It's owner-only on a normal filesystem (on Azure, whoever can read the share can read it) and never mirrored by `just pull`; don't copy it anywhere. Deleting it logs Pixel out at the next restart. If it's unreadable, Pixel starts logged out (`openr.session_unreadable`) and the next login replaces it.

### If a door or the gate opened when it shouldn't have

1. **Stop it now:** `/admin` → Doors → **Switch door control off…**. If you don't trust Pixel at all, also `/admin` → OpenR → **Log out…**, or change the OpenR account's password in the OpenR dashboard (that ends every session, including Pixel's, without depending on Pixel).
2. **Find who Pixel opened it for:** search the logs for `openr.door_opened` and `parking.gate_opened`, and act on the Discord ID, never the name (see [Moderation](#moderation)). OpenR's own logs show only Pixel's account.
3. **If that Discord account looks taken over:** ban or time it out, `/admin` → People → **Change level…** to guest, and revoke `openr` and `parking`.
4. **If the OpenR account or the session file may have leaked:** change the account's password in OpenR, then put the new one in `OPENR_PASSWORD` ([Secrets](#secrets)), restart and log in again.
5. Tell the board what you stopped and which ID you found.

## Space state

Members with the `spacestate` capability can set the space open or closed with `/spacestate set state:open|close`. Pixel POSTs to the space's state API with the user and token, and expects `SUCCESS` back.

**Turn it on** (local `.env`, or the Container App env plus Key Vault for the user and token):

1. Set `SPACESTATE_API_URL` to the API address, and `SPACESTATE_USER` and `SPACESTATE_TOKEN` to the credentials it expects. Set all three or none: setting only some stops startup.
2. On Azure, first put `SPACESTATE_USER` and `SPACESTATE_TOKEN` in `.env.<env>` and `just secrets-push <env>`, which creates the Key Vault secrets `spacestate-user` and `spacestate-token`. Then set `spacestate_api_url` in the environment's `terraform.tfvars` and apply. Terraform only references the two secrets; it never writes them.
3. Optional: if the API needs extra request headers, set `SPACESTATE_ADDITIONAL_HEADERS` to a JSON object such as `{"X-Example": "value"}`. It is a secret so the values stay out of the public repository. On Azure, push it with `just secrets-push <env>` (Key Vault secret `spacestate-additional-headers`) first, then set `spacestate_additional_headers_enabled = true` and apply.
4. Restart Pixel, then run `just register dev` (or `prod`) so Discord shows `/spacestate`.
5. An admin grants the capability: `/admin` → People → **Grant capabilities…**. Being an admin is not enough.
6. Try `/spacestate set state:open`, then check `/status`. Pixel follows the state it reads back from SpaceAPI, so the change is announced the usual way.

**Turn it off:** unset all three variables (on Azure, unset `spacestate_api_url`). The command stays but says it isn't set up. To stop one person, revoke their capability.

**If it fails:** the person is told nothing changed, and Sentry gets an event tagged `spacestate` with a message such as "did not accept the change" (the API answered something other than `SUCCESS`), "responded with HTTP 403" (wrong user or token) or "request failed" (unreachable). The message never has the URL, the token or the API's answer. Check the credentials first. Pixel never retries.

**See the request and response:** in Sentry, a failed `/spacestate set` event has a `spacestate_api` section (Contexts), and every call, successful or not, has the same fields as `spacestate_api.*` attributes on the `spacestate` command's trace. They hold the address without its query (the user and token are never shown), the state sent, the HTTP status, content type and length, the response body (control characters removed, cut to 1,024 characters, and left out entirely when over the 4 KiB cap or unreadable), the outcome (`success`, `rejected`, `http-error`, `too-large`, `unreadable` or `network-error`) and how long it took. For a `network-error` they also name why when the underlying error says (`errorCause`: a code such as `ENOTFOUND` or `ECONNREFUSED`, or `UNEXPECTED_REDIRECT` when the API answered with a redirect, which Pixel refuses because the token is in the URL). Request headers, including `SPACESTATE_ADDITIONAL_HEADERS`, are never sent. Without a Sentry DSN nothing is collected.

The user and token are in the URL's query string, so treat anything that could hold the whole URL (a proxy log, a copy of the settings) as a secret.

## Secrets

Every secret lives in the secret store for its environment (a local `.env` for development, Key Vault `pixel-dev-kv` in Azure `dev`) and nowhere else. Pixel never logs them, and scrubs anything shaped like a Discord or Home Assistant token from logs and Sentry, but don't rely on that. After rotating, **restart Pixel**: secrets are read once at startup.

| Secret | Where it comes from | Rotate when |
| --- | --- | --- |
| `DISCORD_TOKEN` | Discord Developer Portal; Key Vault `discord-token` | It may have leaked, someone with access leaves, or on a schedule |
| `HOME_ASSISTANT_TOKEN` | A long-lived token in HA; Key Vault `home-assistant-token` | It may have leaked, or the Pixel user changes |
| `MASTODON_ACCESS_TOKEN` | Instance Development app (`write:statuses`); Key Vault `mastodon-access-token` when hosted | It may have leaked, the app is rotated, or you move instance |
| `SPACESTATE_USER`, `SPACESTATE_TOKEN` | Whoever runs the space state API; Key Vault `spacestate-user` and `spacestate-token` when hosted | They may have leaked, or the API's credentials change |
| `OPENR_EMAIL`, `OPENR_PASSWORD` | Pixel's own OpenR account; Key Vault `openr-email` and `openr-password` when hosted | The password may have leaked, someone who read the account's mail leaves, or the account changes |
| `SENTRY_DSN` | Sentry project settings; Key Vault `sentry-dsn` | It's being abused, or you move projects |
| Tailscale auth key | Tailscale admin; Key Vault `tailscale-auth-key` | It may have leaked, or you rotate tagged keys |
| `admins.yaml` | Hand-edited; Key Vault `admins-yaml` (not a token) | When admins change |

**The list of secrets** lives in [`infra/secrets.manifest.yaml`](../infra/secrets.manifest.yaml) ([ADR 0015](adr/0015-secrets-manifest.md)): Key Vault name, environment variable, what turns it on. Names only, never values. `just validate-secrets` checks it and prints the list. Terraform builds the vault's secrets and the Container App's secret environment variables from it, and `just check` fails if `src/config.ts`, `.env.example`, the Terraform variables or these docs disagree with it. To add a secret: add an entry to the manifest, its ephemeral and sensitive Terraform variable (module, `envs/dev`, `envs/prod`) and write-only entry in `infra/modules/pixel/secrets.tf`, the setting in `src/config.ts`, `.env.example` and the architecture config table, and a row in the table above; the test names anything you miss.

**Rotate the Discord bot token** (the old one stops working the moment you reset it, so expect a short outage):

1. Discord Developer Portal → the right application (dev or prod!) → **Bot** → **Reset Token**. Copy it once; it isn't shown again.
2. Put it in the secret store as `DISCORD_TOKEN`.
3. Restart Pixel. Check `/ping`, and that `/readyz` is 200.
4. You don't need `just register`: the application and its commands haven't changed.

**Rotate the Home Assistant token:**

1. In HA, as the **non-admin** Pixel user: Profile → Security → Long-lived access tokens → create a new token, then delete the old one.
2. Put the new one in the secret store as `HOME_ASSISTANT_TOKEN`, and restart Pixel.
3. `/admin` should say Connected with no warning about an admin token. If it warns that the token belongs to an admin, the token is from the wrong user: redo it with the non-admin user.

**Rotate the Mastodon token:**

1. On the instance: Preferences → Development → the Pixel application → regenerate or create a new application with **`write:statuses` only**. Copy the access token once.
2. Put it in the secret store as `MASTODON_ACCESS_TOKEN`, and restart Pixel.
3. The next space open or close should appear on the configured account. If Sentry shows `announcer:mastodon` with HTTP 401, the token is wrong or revoked.

**Rotate the space state credentials:**

1. Get the new user and token from whoever runs the API.
2. Put them in the secret store as `SPACESTATE_USER` and `SPACESTATE_TOKEN`, and restart Pixel.
3. Run `/spacestate set` with the state the space is already in. If Sentry shows `spacestate` with HTTP 401 or 403, the credentials are wrong.

**Rotate the OpenR password:**

1. In the OpenR dashboard, as Pixel's account, change the password. That ends Pixel's session (Sentry says so at the next refresh).
2. Put the new one in the secret store as `OPENR_PASSWORD`, and restart Pixel.
3. `/admin` → OpenR → **Log in**, then `/admin` → OpenR → **Enter the code…** with the emailed code. `/admin` → OpenR should say logged in.

**Rotate the Sentry DSN:** Sentry project → Settings → Client Keys: create a new key, disable the old one, update `SENTRY_DSN`, restart. Check that a test event arrives.

**If a secret leaked:** rotate it first, then work out where it leaked from. Check the logs and Sentry for the time window. A leaked Discord token lets someone act as the bot in your server, so treat it as urgent.

**Azure:** "put it in the secret store" means `just secrets-push dev` (or `prod`), below, which also offers the restart. It is the only thing that writes app secrets; Terraform's `write_secrets` writes only the Tailscale key and the registry token ([ADR 0017](adr/0017-one-writer-for-app-secrets.md)). Never commit secret values.

### Sync secrets with Key Vault

`just secrets-pull` and `just secrets-push` keep an environment's **app** secrets (the `app` group in the manifest: Discord token, `admins.yaml`, Home Assistant, Mastodon, space state, Sentry) in step between its Key Vault and your laptop ([ADR 0016](adr/0016-secrets-sync.md)). It is their **only** writer: Terraform references them from the Container App but never writes them ([ADR 0017](adr/0017-one-writer-for-app-secrets.md)). The Tailscale key and the registry token are `infra` secrets: Terraform owns them (`write_secrets`) and the tool never touches them.

| Env | Key Vault | Local env secrets | Local `admins.yaml` | Container App |
| --- | --- | --- | --- | --- |
| `dev` | `pixel-dev-kv` | `.env.dev` | `config/admins.dev.yaml` | `pixel-dev` |
| `prod` | `pixel-prod-kv` | `.env.prod` (must set `PIXEL_ENV=prod`) | `config/admins.prod.yaml` | `pixel-prod` |

These local files are gitignored and written readable only by you. **You need:** `az login` on the Pixel subscription, **Key Vault Secrets Officer** on the vault (Secrets User is enough to pull), and the same storage access as `just ha-devices` (a push reads `members.yaml` from the share to check `admins.yaml`).

**Change a secret:**

1. `just secrets-pull dev`. It reads every app secret from the vault and writes it into `.env.dev` (only those keys; the rest of the file stays as it is) and `config/admins.dev.yaml`. If one of your local values differs from the vault, it lists which and asks before overwriting, so an edit you haven't pushed isn't lost by accident.
2. Edit the value in `.env.dev`, or edit `config/admins.dev.yaml`.
3. `just secrets-push dev`. It reads the vault again (the live values) and lists each secret as `=` the same, `~` changes, `+` new in Key Vault, or `!` only in Key Vault (a push never deletes). Values are never shown, only their length. `admins.yaml` changes are shown as a diff and checked against `members.yaml` on the share, the way Pixel checks them at startup. Each admin added or removed is listed as an `access.changed` record and, once pushed, sent to that env's Sentry Logs with your Azure account as the `user` (as with `members.yaml`, below).
4. Say yes to push. For `prod` you also type `prod`. It stops without writing if the vault changed since it was read (run it again), and reads every value back afterwards.
5. **Restart.** Pixel reads secrets only at startup, so it keeps the old values until it restarts. The tool offers to run `just restart dev` for you; say no and run it yourself when it suits (a restart is a short gap in the bot).
6. Check `/ping` and `/admin` in that environment's server.

**Guards:** it refuses an env file whose `PIXEL_ENV` is for the other bot, and a Discord token that's also in another bot's file (`.env.dev` or `.env` for prod; `.env.prod` for dev). Never copy the Pixel Dev or Mini token into `.env.prod`.

**Old `secrets.auto.tfvars`:** Terraform no longer has app-secret inputs (`discord_token`, `admins_yaml_file`, `sentry_dsn`, `spacestate_user`, …). If your file still sets them, Terraform warns about undeclared variables; delete those lines. Only `tailscale_auth_key` and `container_registry_password` belong there now.

**The first plan after ADR 0017** shows each app secret Terraform had written as "will no longer be managed by Terraform, but will not be destroyed", and any Tailscale or registry secret as "has moved to" `azurerm_key_vault_secret.infra`. That is expected: the secrets stay in Key Vault. If the plan **destroys** an `azurerm_key_vault_secret`, stop and ask (with `write_secrets = false`, Terraform removes the infra secrets it wrote, as it always did).

**A new app secret, or a feature that needs one:** add it to the manifest first (above). Put the value in `.env.<env>` under its environment variable and `just secrets-push <env>` (it shows as `+` new in Key Vault), **then** turn the feature on in the tfvars and apply. The apply only references the secret, so it doesn't need the value.

### Pull and push an environment

`just pull dev|prod` brings down everything you need to work on an environment from another laptop: plan and apply Terraform, change a secret, or look at its config. `just push dev|prod` sends back what you changed.

| What | Local file | Remote | `just push` |
| --- | --- | --- | --- |
| Stack settings | `infra/envs/<env>/terraform.tfvars` | Key Vault secret `terraform-tfvars` (the `tooling` group) | Yes |
| App secrets | `.env.<env>`, `config/admins.<env>.yaml` | Key Vault (as `just secrets-pull`, above) | Yes |
| `members.yaml` | `config/<env>/members.yaml` | File share | Yes, if you edited it (prefer `/admin`). Then `/admin` → **Reload the access lists** |
| `devices.yaml` | `config/home-assistant/<env>/devices.yaml` | File share | Yes, if you edited it (prefer `just ha-devices`). Then **Reload the access lists** |
| `schedules.yaml`, `parking-spots.yaml`, `parking-windows.yaml`, `parking-bookings.yaml`, `announcement-routes.yaml` | `config/<env>/data/` | File share (`data/`) | Yes, if you edited it (prefer `/schedule`, `/admin`). Then a restart, which it offers |
| `closing-time.md` | `config/<env>/data/closing-time.md` | File share (`data/`) | Yes, if you edited it. Used from the next post |

All of them are gitignored. Never mirrored: `data/openr-session.json` (the door session's cookies) and `data/logs/`.

`just pull` records what each share file was in `config/<env>/pulled.json`. That is how `just push` tells your edits from changes Pixel made since: it sends back **only the files you edited since the pull**, so a mirror you didn't touch never goes back over a booking or a schedule Pixel saved meanwhile. If a file you edited also changed on the share since the pull, the push stops: pull again (it shows both and asks before replacing your edit), redo it, and push. A mirror you haven't edited is refreshed by the next pull without asking. Each edited file is checked the way Pixel reads it before anything is pushed, and the push shows the diff, asks, uploads only if the share's copy hasn't changed since it was read, and reads it back.

Pixel reads `schedules.yaml`, the parking files and `announcement-routes.yaml` only when it starts, and its next change to one (a booking, a schedule post) writes what it holds in memory back over the file. So a push of one of those offers to restart the Container App straight away (yes by default): say yes, or restart before anyone uses that feature. Prefer Pixel's own commands for these; a hand edit is for what they can't do.

**Mirrors from before `pulled.json`:** a push lists a mirror that differs from the share with no record of its pull as `?` and leaves it alone. Run `just pull <env>` once; if you have an edit in a mirror, it shows the diff and asks, and saying no keeps your edit for the next push.

**Edit `members.yaml` by hand** (to delete an entry, say; `/admin` → People → **Change level…** and `/admin` → Capabilities are still quicker for what they cover): `just pull dev`, edit `config/dev/members.yaml`, then `just push dev`. It shows the diff against the share, checks the file with the vault's `admins.yaml` (or your local one, if you're pushing that too) the way Pixel does at startup, and asks. It uploads only if the share's copy hasn't changed since it was read: an admin command in the meantime stops it, so pull again and redo the edit. It reads the file back afterwards. Then run `/admin` → **Reload the access lists** in that env (or let it restart). Before asking, it lists each change as an `access.changed` record (a person's level or capabilities, a level's capabilities, someone removed; a note alone isn't one), and after the upload it sends them to that env's Sentry Logs, like Pixel's own, with `user` set to your Azure account (`azure:<you>`) and `source: just-push`. Without a `SENTRY_DSN` for that env it says so and pushes anyway.

The tools that take `dev` or `prod` and load Pixel's config (`just register`, `just command-access`, `just validate-config <env>`, and `just deploy dev`, which validates before it builds) read these files, never the local bot's `config/admins.yaml`, `config/members.yaml` or `config/home-assistant/`. If one is missing they stop and say to run `just pull <env>`. To read other files, set `PIXEL_ADMINS_FILE`, `PIXEL_MEMBERS_FILE` or `PIXEL_HOME_ASSISTANT_DIR` in `.env.<env>`.

**`terraform.tfvars` holds settings, never secrets.** Discord IDs, URLs, feature switches and the like. Secret Terraform inputs (`tailscale_auth_key`, `container_registry_password`: anything the stack's `variables.tf` marks `sensitive`; app secrets are not Terraform inputs at all) go in `infra/envs/<env>/secrets.auto.tfvars` instead: Terraform loads it automatically, it's gitignored, and it never leaves your laptop. `just push` refuses a tfvars that sets a secret, sets a variable the stack doesn't declare, or names the other environment's Key Vault or storage account. It checks the file before showing anything, and the diff hides the value of every sensitive variable, so even a tfvars that wrongly holds a secret never prints it.

**Change Terraform settings:**

1. `just pull prod`.
2. Edit `infra/envs/prod/terraform.tfvars`.
3. `just tf-plan prod` and read the plan.
4. `just push prod` so the next person starts from your settings. It says nothing is applied yet.
5. Apply (`PIXEL_APPLY_PROD=1 just tf-apply prod` for prod, maintainers only).

**First time for an environment:** if Key Vault has no `terraform-tfvars` yet, `just pull` says so (`!` only local). Whoever has the working `terraform.tfvars` moves any secret inputs out of it into `secrets.auto.tfvars`, then runs `just push <env>` to share it.

## Deploys

**What is deployed:** `/ping` ("Pixel `<version>` is up") or `/admin`. The version people see is `package.json` (set when a release is cut) plus the git SHA the image was built from (`PIXEL_VERSION`; `just docker-build` and CD set it). `docker ps` shows the image tag if you run it in a container.

**Roll back to the previous version:** start the previous image tag instead (keep the last few tags, and don't prune them). Rolling back is safe for Pixel's own data: `members.yaml` and the other files stay as they are. If the older version doesn't know a capability that is in `members.yaml`, it logs a warning and ignores it. After a rollback that changes which commands exist, run `just register dev` or `just register prod` so Discord matches.

**After a deploy that adds, removes or renames commands:** a Release registers prod and `just deploy dev` or the Deploy dev workflow registers dev. Otherwise run `just register dev` or `just register prod` against that environment's guild. Topic changes to `/info` need it too.

**Fishbot:** `/fishbot` needs only the existing slash-command permissions; leave privileged intents off. After registration, try `/fishbot say phrase:fish` (public reply: “fish go m00!” addressed to the caller) and `/fishbot say` (private help). The feature has no configuration or saved state. It uses the normal dispatcher rate limits and never listens to ordinary messages. Original replies are retained, including old-school insults; the reference is [sjdiego's Fishbot triggers](https://github.com/sjdiego/fishbot/blob/main/triggers.go). IRC actions render as italics. Channel lookup and the obsolete Outwar URL trigger are omitted.

**Deploys must stop the old instance before starting the new one,** so two never answer at once. Expect a short gap while it restarts. Overlap during a revision swap is still #11.

**Azure CD ([ADR 0010](adr/0010-ghcr-cd.md), [ADR 0013](adr/0013-release-workflow.md)):**

- **`dev`:** from this tree, `just deploy dev`. Builds **linux/amd64** (Azure cannot run Mini arm64 images), pushes `ghcr.io/pixelbar/pixel:<sha>` (or `dev-dirty-*` if the tree is dirty) and `:dev`, then `az containerapp update` on `pixel-dev` only (min=max=1). Then `just register dev` against the Pixel Dev guild from `.env.dev` (or `.env`), then `just sentry-release` (skipped without org/token; a Sentry failure still fails the recipe but after commands are registered). Needs `gh auth refresh --scopes write:packages,read:packages,repo`, Docker, `az` on subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`, and `.env` for register. Does not start Pixel. Pushes and pull requests never deploy by themselves (so a local SHA is not overwritten by another CI head).
- **`dev` from a branch or PR** ([ADR 0018](adr/0018-deploy-dev-workflow.md)): GitHub → Actions → **Deploy dev** → Run workflow with a PR number (`123`), branch or SHA, or `just deploy-remote dev 123` (empty: your current branch, which must be pushed). It resolves the commit (refuses PRs from forks: push the branch here first), runs `just check` on it, publishes `:<sha>` and `:dev`, rolls `pixel-dev` in Environment `dev` (min=max=1, refuses unless the app has `PIXEL_ENV=dev`), registers dev slash commands from the running app's settings, and creates a Sentry release in environment `dev`. No version, tag or Terraform apply. It replaces whatever `pixel-dev` was running, including a laptop deploy, so say so in the team chat first. Runs queue. The register job fails closed until a maintainer sets `github_register_principal_id` in `infra/envs/dev` to `pixel-github-dev`'s principal ID and applies; then **Re-run failed jobs**, or `just register dev`.
- **`prod`:** not on merge. `just deploy prod` refuses. A maintainer runs **Actions → Release → Run workflow** on `main` ([`.github/workflows/release.yml`](../.github/workflows/release.yml)). That runs `just check` on the `main` commit (if it fails, nothing is tagged, published or deployed), cuts Unreleased, tags `vX.Y.Z`, opens a GitHub Release, publishes `:<sha>` / `:vX.Y.Z` / `:main`, uploads Sentry source maps, publishes the docs site, then GitHub Environment `prod` (reviewers, branch `main`) rolls `pixel-prod` to **that same digest**. No Terraform apply. Fails closed without `ARM_*` or if `pixel-prod` does not exist yet. Never copy `pixel-dev-kv` or the Mini local Discord token into prod. After the roll, a second Environment `prod` approval runs **Register prod slash commands**: it reads the app ID, guild ID and `discord-token` reference from `pixel-prod` itself, refuses unless `PIXEL_ENV=prod`, and runs `just register-ci prod` (example access lists, throwaway data dir). It fails closed until `github_register_principal_id` is applied in `infra/envs/prod` ([ADR 0014](adr/0014-release-registers-commands.md)); then **Re-run failed jobs**, or `just register prod` with `.env.prod`. Merges to `main` ([`.github/workflows/cd.yml`](../.github/workflows/cd.yml)) publish the merge SHA and `:main` and upload Sentry maps when image paths changed; they do not log in to Azure. CD runs queue rather than cancel each other. If a SHA is missing from GHCR (a docs-only merge can replace a CD run that had not started yet), re-run CD on that commit or merge again.
- GHCR: CI uses `GITHUB_TOKEN` (`packages: write` on the publish job only). Local uses `gh`. The package is **public** (no secrets in the image) so Azure can pull.
- Prod Azure login is GitHub Environment OIDC (`ARM_*` variables on Environment `prod`). `dev` uses local `az`. Terraform plan on PRs uses Environment `dev` / `prod` `ARM_*` and fails closed if they are missing.
- Neither path applies Terraform. After first create, **dev** apply **ignores** the Pixel container image, so `just tf-apply dev` cannot silently replace the SHA `just deploy dev` pinned. Prod apply sets `container_image`; a later Release roll moves it again. Dev rollback is `az`, not a tfvars bump.
- Rollback: `az containerapp update -g pixel-dev -n pixel-dev --image ghcr.io/pixelbar/pixel:<previous-sha>` (same for `pixel-prod` with a previous SHA or `:vX.Y.Z`). Confirm one replica: `az containerapp replica list -g pixel-dev -n pixel-dev -o table`. After a rollback that changes commands, `just register dev` or `just register prod` so Discord matches.
- If `pixel-dev` is up, do not start the Mini bot (`just dev`) on the same Pixel Dev token.
- **Sentry releases:** `just sentry-release` / the CD job / the Release job. Needs secret `SENTRY_AUTH_TOKEN` and variables `SENTRY_ORG`, `SENTRY_PROJECT`. Those jobs **fail closed** if any are missing. The Deploy dev workflow fails closed the same way, after the roll. Local `just sentry-release` still skips so `just deploy dev` can roll without them.

## CI and CD

What GitHub runs. The same diagrams live in [`architecture.md`](architecture.md#ci-and-cd-pipelines). Job inputs: [`.github/path-filters.yml`](../.github/path-filters.yml).

Each expensive job runs only when a path in its list in [`.github/path-filters.yml`](../.github/path-filters.yml) changed. A first "What changed" job runs [`dorny/paths-filter`](https://github.com/dorny/paths-filter) (`some-with-excludes`). Markdown-only changes skip `just check`, Docker and GHCR. A skipped job never starts and GitHub shows it as passed. If the filter job fails, the expensive jobs still run (fail closed).

**Check** (`just check` + `just build`): `src/`, `scripts/`, `content/` (including `content/info/`), `config/`, root `*.ts` and `*.json` (`package.json`, tsconfigs, `biome.json`, `vitest.config.ts`), lockfile, `.nvmrc`, `.gitignore`, `justfile`, Dockerfile, `.github/workflows/**`, `.github/path-filters.yml`, plus the files the secrets manifest test reads: `infra/secrets.manifest.yaml`, `infra/modules/pixel/*.tf`, `infra/envs/*/*.tf`, `.env.example`, `docs/runbook.md`, `docs/architecture.md`, `docs/infra.md`.

**Image** (Docker smoke on PRs and `main`; GHCR + Sentry on `main`): what the Dockerfile copies: `src/` without tests (`*.test.ts`, `src/testing/`), `content/`, lockfile / `package.json`, `tsconfig.json`, `tsconfig.build.json`, Dockerfile, `.dockerignore`, plus `ci.yml`, `cd.yml` and the filter file.

**Docs** (`docs/`, root `package.json` / lockfile, `biome.json`, `.gitignore`, `.nvmrc`, `justfile`, `docs.yml`, the filter file): Biome lint + VitePress build. Not app CI.

**Always on PRs:** the changelog gate (no `pnpm install`). **Terraform:** the workflow starts when `infra/`, that workflow, the `justfile` or the filter file change; Azure plans run only when Terraform files under `infra/` changed (markdown does not), and otherwise never start (so never wait on an Environment).

**Forcing a rerun:** change a file in the list, or empty-commit one. Re-running the workflow with the same paths still skips the jobs that did not match.

Pull request:

```mermaid
flowchart TD
  pr[Pull request push]
  pr --> clog[Changelog gate always, no install]
  pr --> docs{"docs paths?"}
  docs -->|yes| site[Biome + docs site build]
  docs -->|no| nodocs[Docs workflow off]
  pr --> tf{"infra/, justfile or terraform.yml?"}
  tf -->|yes| tffilter{"terraform paths, not infra markdown?"}
  tffilter -->|yes| tfval[just tf-validate]
  tfval --> tffiles{"infra Terraform files?"}
  tffiles -->|yes| azplan[Azure plan via Environment OIDC]
  tffiles -->|no| noaz[Plan jobs never start]
  tffilter -->|no| notfrun[Skip validate and plans]
  tf -->|no| notf[Terraform workflow off]
  pr --> checkp{"check paths?"}
  checkp -->|yes| check["just check + just build"]
  checkp -->|no| nocheck[Skip just check]
  pr --> imagep{"image paths?"}
  imagep -->|yes| docker[Docker image smoke]
  imagep -->|no| nodocker[Skip Docker]
```

Merge to `main`:

```mermaid
flowchart TD
  main[Push to main]
  main --> ci[Same path filters as PRs]
  main --> queue[CD runs queue, never cancel]
  queue --> imagep{"image paths in this push?"}
  imagep -->|yes| pub["CD: GHCR SHA and :main"]
  pub --> maps[Sentry source maps]
  imagep -->|no| nocd[Skip GHCR and Sentry]
  main --> clogp{"CHANGELOG.md changed?"}
  clogp -->|yes| clogm["Changelog merge: merge main into open PRs, push if only CHANGELOG conflicts and it's safe"]
  main --> note[Does not roll pixel-prod]
```

Release ([ADR 0013](adr/0013-release-workflow.md)): GitHub → Actions → **Release** → Run workflow on `main`.

```mermaid
flowchart TD
  human[Actions Release on main]
  human --> check[just check on main HEAD]
  check --> bump[just bump commit]
  bump --> tag[Tag vX.Y.Z and GitHub Release]
  tag --> img["Rebuild GHCR :sha, :vX.Y.Z, :main"]
  img --> sentry[Sentry maps environment prod]
  img --> approve[Environment prod approval]
  approve --> roll[az containerapp update pixel-prod]
  roll --> approve2[Environment prod approval]
  approve2 --> register[Register prod slash commands]
  tag --> pages[VitePress to GitHub Pages]
  bump --> clogm[Changelog merge into open PRs]
```

Deploy dev ([ADR 0018](adr/0018-deploy-dev-workflow.md)): GitHub → Actions → **Deploy dev** → Run workflow, or `just deploy-remote dev <ref>`.:

```mermaid
flowchart TD
  human["Actions Deploy dev: PR number, branch or SHA"]
  human --> resolve{"Branch in this repo?"}
  resolve -->|fork PR| refuse[Refuse]
  resolve -->|yes| check[just check on that commit]
  check --> img["GHCR :sha and :dev"]
  img --> roll["Environment dev: az containerapp update pixel-dev"]
  roll --> register[Register dev slash commands]
  roll --> sentry[Sentry maps environment dev]
  human --> note[Never touches pixel-prod]
```

## Changelog and versions

User-facing and operator-facing changes are recorded in [`CHANGELOG.md`](../CHANGELOG.md), in [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) format. The version people see in `/ping` and the online post is `package.json` (plus the git SHA the image was built from).

**On every pull request** that users or operators would notice (commands, behaviour, config, deploy, monitoring, this runbook): add a short bullet under `## [Unreleased]` in the right category (`Added`, `Changed`, `Fixed`, …). CI fails the PR if `CHANGELOG.md` is untouched. Pure chores (typos, CI-only, no user or operator impact) may use the `skip-changelog` label instead; adding or removing that label re-runs the check. Create the label on the repo once if it does not exist yet.

**Changelog conflicts.** Two PRs that both add entries conflict in `CHANGELOG.md` once one merges, and after a release every open PR does. Keeping both sides is almost always right, so:

- **On GitHub,** [`.github/workflows/changelog-merge.yml`](../.github/workflows/changelog-merge.yml) runs whenever `main`'s `CHANGELOG.md` changes (and after each Release). For every open PR from this repo that edits it, it merges `main` in. If `CHANGELOG.md` is the only conflict and it's safe, it pushes the merge commit and comments on the PR. If it isn't safe, it comments once, saying why, and changes nothing. Fork PRs and PRs with other conflicts are left alone. The run's summary lists each PR's outcome.
- **On your laptop,** in a merge or rebase that stopped on `CHANGELOG.md`: `just changelog-merge`. To have git do it by itself in this clone: `just changelog-merge-driver` (undo with `git config --unset merge.changelog.driver`).

"Safe" means [`scripts/changelog-merge.ts`](../scripts/changelog-merge.ts) can do it without guessing. The branch's new `[Unreleased]` entries go at the end of their section (no section is ever added twice), and an entry both sides added is kept once (or left out, if `main` has already released it). After a release, the branch's entries go into the new, empty `[Unreleased]`. It refuses, and leaves the conflict to you, when both sides changed the same entry, when the branch changed an entry that has since been released, when either side has a section twice, an unknown `###` heading or text that isn't a list entry, or when both sides changed the released versions, the intro or the links.

Setting it up: pushes made with `GITHUB_TOKEN` don't start CI, and can't bring workflow changes from `main` into a branch. So create a GitHub App on the org with **Contents**, **Pull requests** and **Workflows**: read and write, install it on `pixelbar/pixel`, then set the repository variable `CHANGELOG_BOT_CLIENT_ID` (its client ID) and the secret `CHANGELOG_BOT_PRIVATE_KEY` (a private key). Until then the workflow pushes with `GITHUB_TOKEN`. Its comment then says CI hasn't run (push again, or close and reopen the PR), and a merge that brings in workflow changes is refused.

**To cut a version** (move Unreleased into a dated section and bump `package.json`):

```sh
just bump            # writes the files; you commit
just bump --commit   # also commits and tags vX.Y.Z
```

`Added` is a minor bump (`0.1.0` → `0.2.0`). `Fixed`, `Changed` and the other Keep a Changelog types are a patch (`0.1.0` → `0.1.1`). Until 1.0 the major version is never bumped this way. Do not invent the version date; the recipe uses today's UTC date.

**To ship that version to prod and the docs site:** GitHub → Actions → **Release** → Run workflow → branch `main`. The workflow first runs `just check` on that `main` commit (CI on `main` can be cancelled or red, and the bump commit on top only changes `CHANGELOG.md` and the `package.json` version). If it passes, it runs the same `just bump --commit`, pushes the tag, opens a GitHub Release with the Unreleased notes, builds the image from that commit, waits on Environment `prod` to roll `pixel-prod`, waits on it again to register prod slash commands, and publishes GitHub Pages. If the previous version was never tagged, it also tags that parent commit so the changelog compare links work. The bump commit uses `GITHUB_TOKEN`, so it does **not** start CD. If Azure or Pages fails, use **Re-run failed jobs** on that run. If `just check` fails, nothing was tagged or shipped: fix `main` (or re-run if it was a flake) and run Release again. `PIXEL_VERSION` in the image remains the git SHA.

Do not run `just bump` on a feature branch unless you are deliberately cutting a release there. Do not merge to `main` expecting prod or the docs site to move.

## Incidents

**The bot is offline or doesn't answer**

1. Look at Pixel's latest status post in the announcements channel: "offline" means it was shut down, "stopped unexpectedly" means it crashed (check the logs and Sentry for why), and a missing post for a start you expected means it never got as far as Discord. If Sentry's `pixel-<env>` cron monitor alerted, it tells you when the last good check-in was. `/ping` in Discord. No answer? Check `/readyz` and `/healthz`. 503 on `/readyz` means the process is up but the Discord gateway isn't connected.
2. Look at the logs for the last few minutes (console, `data/logs/current.log` or Sentry Logs). A start-up failure prints `Pixel failed to start:` with the reason (a bad config file, a missing admin list, an invalid token).
3. Common causes: a bad edit to an access file (`just validate-config`), a reset or expired Discord token (rotate it, restart), Discord itself being down (check Discord's status page, then wait), or the host being out of resources.
4. Restart it. If it keeps failing, roll back (see [Deploys](#deploys)).
5. Tell the team in the channel what you found.

**Azure (`dev`):** Portal → Container App `pixel-dev` → Log stream / Console, or `az containerapp logs show -g pixel-dev -n pixel-dev --follow`. Restart: `az containerapp revision restart -g pixel-dev -n pixel-dev`. 🚧 Where alerts arrive is still not decided.

**Duplicate replies, "I don't know that command" for a command Discord lists, or Discord shows an error and then the action still happens**

Two instances are connected with the same token. Discord's slash list comes from `just register`; each running Pixel answers from its own code. An older instance replies "I don't know that command" (or answers first); the newer one still does the work and then fails to ACK (Discord 40060, "already acknowledged"). Logs on either side show `discord.duplicate_handler`.

Find and stop the extra one: `docker ps` locally (leftover `just dev` or a worktree container), and check that nobody has a copy on a laptop or another server. In Azure: `az containerapp replica list -g pixel-dev -n pixel-dev -o table` must show one replica (same for `pixel-prod` once it exists). Never fix this by raising limits. CD pins min=max=1. Retry the command after only one instance is left.

**Discord says "The application did not respond"** (log `discord.slow_ack`, Sentry `SlowAcknowledgementError`)

Pixel didn't acknowledge the command within Discord's 3 seconds (Discord 10062, "unknown interaction"). That is Pixel being slow, not a second instance. The log and the Sentry title name the command. Usual causes: the host is overloaded or the event loop was blocked, the network to Discord is slow, or a command that opens a form did slow work before showing it. One-offs after a restart or a Discord hiccup can be ignored. If it repeats for one command, open an issue with the command and the time.

**Announcements to a channel are off** (log `discord.announce_disabled` or `announcements.route_off`, Sentry "Announcements to … are off")

The message says why. "there's no channel with that ID": the channel was deleted, or the ID in the setting is wrong (a server ID is not a channel ID). "the bot can't see the channel" or "lacks these permissions there: ViewChannel": the channel or its category is private. In the channel's settings → Permissions, add Pixel's role and allow View Channel, Send Messages, Embed Links and Read Message History. Re-inviting the bot doesn't help, because that changes its server-wide role, not the channel. Pixel tries a broken channel again when Discord says a channel or role changed, and every 5 minutes, so there's nothing to restart: `discord.announce_enabled` or `announcements.route_on` in the logs means it's posting again. A bot status channel that comes back mid-run posts at the next shutdown or start.

**SpaceAPI is down** (`/status` says "Couldn't check")

Pixel can't tell whether the space is open, so it says so rather than guess. Check `https://spaceapi.pixelbar.nl/` yourself. When it's back, `/status` works again by itself and changes are announced as normal. Nothing to restart. Pixel never announces a change it didn't see itself, so a restart or an outage never produces a stale announcement. If it stays down, that is a problem with the space's own server, not with Pixel.

**The wiki is down** (`/wiki` says "Couldn't search the wiki"; log `wiki.search_failed`)

`/wiki` still answers, with a link to the wiki, and keeps showing the top pages it last read. Check `https://wiki.pixelbar.nl/` yourself. When it's back, `/wiki` works again by itself. Nothing to restart. If the wiki has moved, set `WIKI_API_URL` to its new `api.php` and restart: Pixel doesn't follow redirects.

**Mastodon is down or rejecting toots** (Sentry `announcer:mastodon`)

Discord and the rest of Pixel keep working. Check the instance is up, the token is still valid (`write:statuses`), and `MASTODON_INSTANCE` is the origin (not a profile URL with a typo). Nothing to restart unless you changed config. Pixel does not retry a failed toot (that could double-post).

**Home Assistant is unreachable** (`/admin` shows not connected or off; `/ha` says it can't reach it)

1. `/admin` shows why. "Off: the token was refused" means the token was revoked or replaced: make a new one (see [Secrets](#secrets)). Not connected means it can't reach the HA URL: check HA is up and the network or tunnel between them.
2. Pixel keeps reconnecting by itself, never queues an action and never retries one, so nothing will fire late when it's back. If it couldn't reach HA at startup, the logs say `home.connect_failed` once and it keeps trying (waiting up to a minute between attempts); `home.ready` means it got through.
3. After fixing it, `/admin` → **Reload the access lists** re-checks the connection.

**Someone has the wrong access**

`/admin` → People → **Look someone up…** shows their tier, where it comes from and their capabilities. Fix it with `/admin` → People → **Change level…** or by editing the files (see [Access lists](#access-lists)).

## Sentry

Sentry gets errors (with the tags `command`, `feature`, `platform`, `tier` and the user's ID, so you can see who ran into it), Logs (every log line at `info` and above), **traces** (a span per command, plus outbound HTTP), **CPU profiles** of those traces, **runtime metrics** (CPU, memory, event-loop delay), process **sessions** (crash-free rate for the bot staying up), and **User Feedback** from people using `/feedback`.

**Retention:** the [privacy notice](privacy.md) documents **30 days** for Sentry (same as Azure Log Analytics). 🚧 Apply that in the Sentry project (Settings → Security & Privacy / Data Retention). Terraform does not set Sentry retention.

Errors are always sent (`sampleRate` 1). Traces use `SENTRY_TRACES_SAMPLE_RATE` (default 1: keep them all). Profiles use `SENTRY_PROFILE_SESSION_SAMPLE_RATE` (default 1). `/healthz` and `/readyz` are not traced.

- **Where alerts go:** 🚧 not decided. Set up alert rules for new issues in prod, and write here who is notified and where (email, Discord channel).
- **Pixel going quiet:** Pixel checks in with a Sentry cron monitor, `pixel-prod` or `pixel-dev` (Sentry → **Crons**), every 5 minutes while it's connected to Discord. If check-ins stop (a crash, a hang, the host down) or say it's disconnected, the monitor opens an issue within about ten minutes, and closes it by itself when Pixel is back. A laptop `just dev` (`PIXEL_ENV=local`) never checks in, even with a DSN, so stopping it doesn't alert anyone; if Sentry still lists an old `pixel-local` monitor, delete it. In the monitor's settings, set who is alerted. 🚧 Record here who that is.
- **Planned downtime:** a restart or deploy fits in the five-minute margin. For anything longer, mute the monitor in Sentry first (Crons → the monitor → Mute) and unmute it after, or you'll be alerted.
- **Triage an error:**
  1. Open the issue and read the stack, the tags and the user. The user is their ID, so you can find what they did in the logs (see [Moderation](#moderation)).
  2. Check the breadcrumbs: recent access changes and device actions leave notes there.
  3. Decide: a bug in Pixel (open a GitHub issue, link the Sentry issue), a problem outside it (SpaceAPI, Home Assistant, Discord: see [Incidents](#incidents)), or noise (resolve or ignore it).
  4. If it's urgent and recent, roll back (see [Deploys](#deploys)).
- **Read feedback:** Sentry → **User Feedback**. Each has the sender's Discord name and ID, so you can reply in Discord.
- Errors from before a release can be filtered by the `release` tag, which is `PIXEL_VERSION` (the git SHA the image was built from). Source maps upload from `just sentry-release` / CD when `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` are set, and Sentry uses them to show the TypeScript source. Stack traces in the container logs and the log files point at the compiled `dist/*.js` lines instead: open the Sentry issue for the TypeScript line.

## Privacy requests

The public notice is [`privacy.md`](privacy.md) (linked from `/help`). This section is the operator process. **Board sign-off** on the notice, the controller (association vs board), and whether it extends another Pixelbar policy is still outstanding. Do not invent those answers.

Under GDPR, someone can ask what Pixel holds about them, or ask for it to be deleted. You have **one month** to respond, so note the date you received the request. Requests go to [bestuur@pixelbar.nl](mailto:bestuur@pixelbar.nl). First confirm who is asking: the person must be the one whose Discord ID it is (they can show `/whoami` in Discord). Never put real Discord IDs or names in the git repo, a pull request or a public issue.

**Where personal data is:**

| Where | What | How long |
| --- | --- | --- |
| `members.yaml` (and `members.yaml.bak`) | ID, tier, any note, capabilities | Until removed |
| `admins.yaml` (host file, and Azure Key Vault) | Admin Discord IDs | Until removed |
| `data/schedules.yaml` | Creator ID and name, channel, scheduled message or poll text | Until the schedule is deleted |
| `data/attendance.yaml` | Each attendance poll's creator ID, and every voter's ID, display name and answer | A week after the poll closes |
| `data/parking-windows.yaml` | ID and name of the admin who set each opening or closure | Until it ends (the daily reset at the latest) |
| `data/parking-bookings.yaml` | ID and name of who is parked, which spot, since and until when | Until the booking ends (the daily reset at the latest) |
| Azure Files backups of those files | The same files | 14 days |
| Pixel's log file and console | ID, display name, handle, and what they did (commands, outcomes) | About 14 days (rotating file) |
| Azure Log Analytics (`pixel-dev-logs`) | The same log lines, from the container | 30 days (`log_retention_days` in Terraform; Azure's floor) |
| Sentry (errors, Logs, User Feedback) | The same, plus any feedback they sent | **30 days intended.** 🚧 Set this in the Sentry project (Settings → Security & Privacy / Data Retention). Not applied from this repo |
| Discord | Everything Discord itself holds | Not Pixel's data: refer them to Discord |

Pixel has no database. Message content and command arguments are never logged, except a `/feedback` message, which goes to Sentry as feedback.

**Access request ("what do you have on me?"):**

1. `/admin` → People → **Look someone up…** for their tier, note and capabilities, or read their entry in `members.yaml`.
2. Search `data/schedules.yaml` for their ID (`createdBy.ref`) and list those schedules, `data/attendance.yaml` (`votes[].ref`, `createdBy`) for their answers on attendance polls, and `data/parking-bookings.yaml` (`by.ref`) and `data/parking-windows.yaml` (`setBy.ref`) for a booking or opening times they set.
3. Search the logs by their ID (see [Moderation](#moderation)): the rotating file, Sentry **Logs**, and Azure Log Analytics when Pixel is in the cloud.
4. In Sentry, search Issues, Logs and User Feedback for their ID.
5. Send them a copy of what you found, and no one else's data.

**Deletion request:**

1. Remove their entry from `members.yaml` by hand (and `admins.yaml`, if they were an admin), then `/admin` → **Reload the access lists**. If they were an admin, update the Key Vault `admins.yaml` secret too. Keep the entry's removal out of any shared notes: don't write their name or ID in the git repo or a public issue.
2. Delete `members.yaml.bak` if it still has their entry (or wait for the next rewrite after another access change).
3. Delete their scheduled posts (remove those entries from `data/schedules.yaml` and restart; only they can delete them in `/schedule`). Remove their votes from `data/attendance.yaml` and restart, or wait: closed polls drop out a week after they close. They can also take back an answer on an open poll by pressing it again. End any parking booking they hold (**Free the spot…** in `/admin` → Parking); entries they set in `data/parking-windows.yaml` end by the next reset.
4. Logs: the file ages out within about 14 days; Azure Log Analytics within 30. If it must be sooner, remove their lines from the log files and from Log Analytics. 🚧
5. Sentry: delete their events, logs and feedback using Sentry's data deletion tools.
6. Azure Files backups of the persist share age out in 14 days. Do not restore an old share after a deletion unless you have stripped that person out first.
7. Tell them what was removed and what was not (for example Discord's own data), and when the remainder will age out.

## Disaster recovery

**What to back up:** `config/admins.yaml`, `config/members.yaml` (it changes at runtime, so it needs regular snapshots; `members.yaml.bak` is only the previous copy), `config/home-assistant/devices.yaml`, and the values of the secrets. `data/schedules.yaml` (the scheduled posts), `data/attendance.yaml` (the votes on open attendance polls) and `data/parking-spots.yaml` (the parking spots and settings). Not needed: the rest of `data/` (state and logs, safe to delete; don't back up `openr-session.json`, which is a door credential: after a restore an admin logs in to OpenR again), a leftover `inventory.yaml`, `dist/` and `node_modules/`. The code is in git, and `content/` (the `/info` topics) is in the image.

**Rebuild from scratch (today):**

1. Get the code at the version you want: `git checkout <sha>`.
2. Recreate `.env` from the secret store (`DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `HOME_ASSISTANT_*`, `SENTRY_DSN`, the channel and role IDs). If the Discord application is gone, make a new one in the Developer Portal, invite the bot with the permissions it needs, and update the IDs.
3. Restore `admins.yaml`, `members.yaml` and `devices.yaml` from backup, then `just validate-config`.
4. `just register dev` or `just register prod`, then start Pixel.
5. Check `/ping`, `/admin` and `/ha`. Run `/admin` → Discord roles → **Sync everyone** if roles are mirrored.

If `members.yaml` is lost and there's no backup, Pixel won't start (it fails closed). Restore the last backup, or rebuild the file from `members.example.yaml` and re-add people with `/admin` → People → **Change level…** once an admin can start it.

**Bootstrap state:** the storage account `pixelbartfstate` has versioning and 14-day soft delete. Restore a previous `terraform.tfstate` blob if remote state is damaged. If bootstrap was never migrated off the laptop, that local file is the backup — migrate it.

**Azure app (`dev`):** recreate with `just tf-apply dev` after bootstrap exists (the resource group is already there). Restore Key Vault secret values from wherever you keep them (they are not in Terraform state; app secrets with `just secrets-push dev` from your `.env.dev`, the Tailscale key and registry token with `write_secrets` or `az keyvault secret set`). Restore `members.yaml` / HA files / `schedules.yaml` from Azure Backup of the file share (14 days) or a copy you kept. Practise this in `dev`. Prod is the same layout in `pixel-prod` ([`infra/envs/prod/README.md`](../infra/envs/prod/README.md)).

## Keeping this up to date

- **Change infrastructure, change this file.** A pull request that changes how Pixel is built, configured, deployed or monitored must update the matching section here (and `architecture.md`). A CI/CD change must also update the pipeline diagrams in this file and in `architecture.md`. This is noted in `AGENTS.md`. The same change also needs a `CHANGELOG.md` Unreleased entry unless it is a pure chore (`skip-changelog`).
- **When Terraform lands:** search for `🚧` and replace each one with real steps, keeping the "Today" steps only where they still apply. Add the real environment names, links and the on-call contact to "Who and what".
- **Every procedure should be followed once by someone other than its author, in dev,** before it's trusted. Fix whatever they trip over, and note the date here if you like.
- **After an incident,** add what you learned: a missing step, a better check, a new entry under [Incidents](#incidents).
