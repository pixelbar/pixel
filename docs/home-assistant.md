# Home Assistant

How to set up Pixel's Home Assistant integration, what it can do, and what to do when something is wrong. Day-to-day steps (rotate the token, add a device, emergency stop) are also in the [runbook](runbook.md#home-assistant). The choices behind this are [ADR 0011](adr/0011-home-assistant.md). How the commands work is in [architecture](architecture.md#home-assistant-a-client-not-an-adapter); who may use a device is in [identity and access](identity-and-access.md#home-assistant-devices).

**Keep real URLs, tokens, Discord IDs and the space's device names out of the repository.** Use a test Home Assistant until you are ready for prod. `dev` must not control the real doors.

## Limits

Read this before you create a token.

| Home Assistant does | Pixel does |
| --- | --- |
| A long-lived token has **every right of its user**. Tokens are not scoped to devices or services. | Uses a **dedicated non-admin** user, so a leak cannot change HA users, integrations or system settings. |
| A non-admin user can still turn on lights and unlock locks they can see. | Only touches devices in `config/home-assistant/devices.yaml`. That file is the fence. |
| Webhooks are authenticated only by knowing the webhook id. Official docs say **do not use a webhook to unlock a lock**. | Never exposes a webhook. Pixel is the client: a Discord command makes one authenticated WebSocket call. |
| Entity permissions on groups exist, but Pixel does not rely on them. | One rule in `core/home-access.ts`: tier floor, plus a capability, plus an action the file allows. |

Pixel can only send catalogue actions (`light.turn_on`, `lock.unlock`, …). People cannot type a service name or extra data. Doors only lock and unlock; Pixel never unlatches. Nothing is queued or retried, so a late unlock cannot happen after HA was down.

## Setup (on a test Home Assistant)

Follow this on a throwaway or staging instance first. The same steps apply later to prod, with a **different** user, token, URL and devices file.

### 1. Create a dedicated non-admin user

In Home Assistant (as an administrator):

1. **Settings → People**. Add a user that is **not** attached to a person (this is a service account, not someone who lives in the space).
2. Give it a name such as `Pixel` (or `Pixel Dev` on the test instance).
3. Do **not** make it an administrator. Administrators can change users, integrations and system settings.
4. Local-only is fine if Pixel will only ever reach this instance on the LAN or Tailscale. If Pixel will use a Nabu Casa URL, the user must be allowed to sign in remotely.

Do not reuse a person's own account.

### 2. Make a long-lived token

1. Sign in **as that non-admin user** (not as your admin).
2. Open the user profile (your name, bottom-left) → **Security**.
3. Under **Long-lived access tokens**, create a token. Name it for the environment (`pixel-dev`, `pixel-local`).
4. Copy it once. Home Assistant will not show it again.
5. Store it as `HOME_ASSISTANT_TOKEN`: local `.env`, or Key Vault `home-assistant-token` on Azure. Never paste it into chat, an issue, a pull request or a log.

The token lasts about ten years until you delete it. Deleting it in Home Assistant is the emergency stop: Pixel's next call is refused.

### 3. Choose the Home Assistant URL

`HOME_ASSISTANT_URL` is the address **this Pixel process** can open a WebSocket to. Pick one:

| Path | When to use it | What to put in the setting |
| --- | --- | --- |
| **Nabu Casa Remote UI** | Local laptop, or Azure `dev` until Tailscale is on. Home Assistant → **Settings → Home Assistant Cloud**. | The Remote UI origin, `https://….ui.nabu.casa` (no path, no trailing slash needed). |
| **LAN** | Pixel runs on the same network as Home Assistant (a machine in the space). | `http://homeassistant.local:8123` or `http://<lan-ip>:8123`. Use `https` if the instance is served that way. |
| **Tailscale** | Azure Container App talking to the space LAN. Preferred on hosted Pixel ([#43](https://github.com/pixelbar/pixel/issues/43)). | The address the sidecar can resolve (MagicDNS or Tailscale IP). Userspace sidecar; LAN MagicDNS through it is still remaining work. |

Do not commit the URL. No instance is hard-coded. Both URL and token, or neither: only one set stops startup.

If Pixel itself is served over HTTPS, Home Assistant's client requires the HA address to be HTTPS too.

### 4. Pixel settings

In `.env` (see `.env.example`) or the Container App / Key Vault:

| Setting | What to set |
| --- | --- |
| `HOME_ASSISTANT_URL` | The origin from the table above |
| `HOME_ASSISTANT_TOKEN` | The long-lived token |
| `PIXEL_HOME_ASSISTANT_DIR` | Optional. Defaults to `config/home-assistant`. On Azure this is on the persist share |

Copy the example allow-list, then empty it so Pixel does not warn about sample entities that your test instance does not have:

```sh
mkdir -p config/home-assistant
cp config/home-assistant/devices.example.yaml config/home-assistant/devices.yaml
```

Edit `devices.yaml` so the list is empty to start:

```yaml
devices: []
```

`devices.yaml` is gitignored (it describes the building). `just validate-config` must say OK. A missing file while the URL is set stops Pixel from starting.

On Azure `dev`, put the token in Key Vault (`home-assistant-token`) and the URL in the Container App env. Upload `devices.yaml` to the Files share (`home-assistant/`). See the [runbook](runbook.md#azure-container-app-dev). Restart the app after changing secrets.

### 5. Start Pixel and check the connection

```sh
just validate-config
just dev          # or just deploy-dev for Azure pixel-dev
```

In Discord, `/admin status` should show **Connected** and `0 devices allowed`. If it warns that the token belongs to an admin, you signed in as the wrong HA user: delete that token, go back to step 2 as the non-admin user.

`/ha list` as a friend or member says there is nothing available to you, which is right until you add devices.

### 6. Add devices

On Azure, `just ha-devices dev` (or `prod`) does this for you: it reads what Home Assistant has, lets you pick, and pushes the checked file to the share. See the [runbook](runbook.md). By hand, write an entry in `devices.yaml` (the entity ID is on the entity's page in Home Assistant) and set `minTier` and `actions`. Example (names here are from `devices.example.yaml`, not the space):

```yaml
devices:
  - name: workshop-light
    entity: light.workshop
    kind: light
    actions: [on, off, toggle]
    description: The main light in the workshop
```

Rules that bite:

- `name` is what people type: lowercase words joined by `-`, up to 32 characters.
- `entity` must match the kind's domain (`light.*`, `switch.*`, `lock.*`, `sensor.*` / `binary_sensor.*`).
- Omit `actions` (or use `[]`) for read-only.
- Doors are member-only. `minTier: friend` on a door is refused. Doors only accept `lock` and `unlock` (not `open`).
- At most 200 devices.

Then:

```sh
just validate-config
```

`/admin reload` (or restart). The reply says how many devices are allowed and names any entity Home Assistant does not know (a typo). `/ha list` shows the ones your tier may see.

Grant capabilities before anyone can change something: `/admin capabilities grant user: capability:ha-lights` (or `ha-switches`, `ha-doors`, `ha-admin`). Nothing implies a capability, including being a Pixel admin.

### 7. Try an action on the test instance

As someone who holds the capability, `/ha set device: workshop-light state: on`. The private reply says what really happened. Search the logs for `home.action` if you want to see the audit line (IDs, device, action, before, after, outcome — not a token).

Doors: `/ha set` lock/unlock, or `/ha open door:` (always unlocks). `/admin doors off` stops every door action at once.

## Revoke

| I need to… | Do this |
| --- | --- |
| Stop **everything** Pixel can do in Home Assistant, at once | In HA, as the Pixel user: **Profile → Security → Long-lived access tokens → delete**. The next call is refused. Does not depend on Pixel being healthy. |
| Stop **one device** | Remove its `actions` (or the whole entry) from `devices.yaml` and `/admin reload`. |
| Stop **all doors** | `/admin doors off`. Survives restarts. |
| Stop **one person** | Ban or time them out in Discord, `/admin level set` to guest, revoke their capabilities. See the [runbook](runbook.md#moderation). |
| Replace a leaked token | Delete the old token in HA first, create a new one as the same non-admin user, put it in the secret store, restart Pixel (or `/admin reload` after a refused token). |

## Threat model

Each row is a threat and what Pixel actually does about it. Identification of Discord users is **only** by immutable user ID. A matching display name or nickname grants nothing.

| Threat | What they can do | Mitigation |
| --- | --- | --- |
| **Leaked `HOME_ASSISTANT_TOKEN`** | Anything that non-admin HA user can do *inside Home Assistant*: every entity they can see, including locks Pixel has not listed. They cannot use Pixel's commands unless they also have the Discord bot token. They cannot change HA users or integrations if the user is not an admin. | Dedicated non-admin user; token only in `.env` / Key Vault; never logged (and token-shaped strings are scrubbed). **Revoke in HA at once** (delete the token). Then store a new one and restart. Pixel's allow-list does not protect HA from a caller who uses the token directly. |
| **Leaked token that belongs to an admin** | The above, plus users, integrations and system settings. | Don't. Pixel warns in `/admin status`, the logs and Sentry if `auth/current_user` says `is_admin`. Redo the token as a non-admin. |
| **Compromised Discord account** of someone with `ha-doors` or `ha-admin` | Unlock (and lock) every door in `devices.yaml`, from Discord, identified as that person. A stolen session of someone with only `ha-lights` can only run listed light actions. | Doors are member-only; the capability is never implied; every door action is logged (`home.action`) with ID, name, handle, device, before/after and outcome; `/admin doors off` without a deploy; revoke the HA token to stop the integration; Discord ban / timeout plus demote to guest. There is **no** confirmation button, public notice, per-person rate limit or "only while the space is open" check yet. |
| **Compromised Discord account** of someone without HA capabilities | They can still run every command their tier allows (`/ha list` and `/ha status` on devices at or below their floor). They cannot change a device. | Same as any other takeover: Discord moderation, then `/admin level set` / revoke. `/ha` refusals say `HOME_DENIED` and do not confirm that a device exists. |
| **Someone who can edit `devices.yaml` or `members.yaml`** | Widen the allow-list (add a door, add `unlock`) or grant `ha-doors` / `ha-admin`. | Files live on a protected volume (Azure Files + snapshots) or a laptop you control. `admins.yaml` is not writable from Discord. Capability grants are audited and the person is DMed. |
| **Compromised Home Assistant admin account, or a wide-open remote-access route** (Nabu Casa, exposed port, leaked sidecar) | Full control of the building, bypassing Pixel. | Pixel cannot fix a broken HA. Use a strong unique password and MFA on HA admins; do not expose HA to the internet except via Nabu Casa or Tailscale; keep the Pixel user non-admin so a *Pixel* leak is not an *HA admin* leak. Rotate HA passwords and the Pixel token. |
| **Home Assistant down or slow** | `/ha` says it cannot reach HA. Discord, SpaceAPI and the rest keep working. | Connect in the background, reconnect forever, fail at once, no queue, no retry, time limit on every call. HA is not on `/healthz`. After a refused token the connection stays off until `/admin reload`. A hung call cannot hold a command forever. |
| **Typo or hostile text from Home Assistant** (friendly names, states, attributes) | Could try to inject mentions or formatting into Discord. | Device names come from `devices.yaml`, not HA. States and attributes are shown as code spans, control characters stripped, length limited. HA's own error text is never shown. |
| **Two Pixels, or `dev` pointed at prod HA** | A test command unlocks the real door. | Separate bots, tokens and (when hosted) vaults. `dev` uses a test HA or none. Never put the prod URL and token in the Pixel Dev app. |

Revisit this table when Home Assistant offers scoped tokens or a supported per-entity API policy, and if the board wants the extra door safeguards left out of #29 (confirmation, public notice, conditions).
