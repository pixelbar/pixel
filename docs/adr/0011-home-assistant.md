# 0011. Home Assistant: official client, allow-list, no inbound webhooks

* Status: accepted
* Date: 2026-10-11
* Issue: #42 (decisions from #37, #38, #29, #41)

## Context

Pixel reads and controls Home Assistant (HA) entities: lights, switches, doors and sensors. The integration holds a credential that can do whatever its Home Assistant user can. That must be written down before it is pointed at the real space.

This is not an adapter that receives commands from Home Assistant. Pixel is the client. Features never talk to HA themselves: they use the core `Home` (`src/core/home.ts`), and only `src/adapters/home-assistant/` talks to the platform.

Setup, the threat model and day-to-day operations live in [`home-assistant.md`](../home-assistant.md) and the [runbook](../runbook.md). This record is the research and the choices.

## Decision

### Official library

Use [`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket) (the library Home Assistant's own frontend uses). It is ESM, typed, has no extra runtime dependencies, reconnects and resubscribes by itself, and works with Node's built-in `WebSocket`. Only the adapter imports it. Tests use `src/testing/fake-home-assistant.ts`, a stand-in that speaks the same protocol, never a live instance.

### WebSocket over REST

Home Assistant has a [REST API](https://developers.home-assistant.io/docs/api/rest/) and a [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/). Pixel uses the WebSocket API, because that is what the official library speaks: authenticate with a long-lived token, read states, call services, and reconnect after a drop. REST would mean a second, unofficial client for the same work.

Reads are always fresh (`get_states`, then keep the entities asked for). Pixel does not subscribe to live state for `/ha list` or `/ha status`. After `/ha set` it polls the state for a few seconds so it can say what really happened. A subscription can be added later if polling is not enough; it must not become a cache of reads.

A slow or missing Home Assistant never holds up Discord. The adapter connects in the background and reconnects forever. Calls fail at once while it is down. HA is not on `/healthz` or `/readyz`: an outage must not restart Pixel.

### How Pixel reaches Home Assistant

`HOME_ASSISTANT_URL` is wherever *this* Pixel process can open that WebSocket: a Nabu Casa Remote UI URL, a LAN address, or a Tailscale address. Both the URL and `HOME_ASSISTANT_TOKEN` or neither; only one set stops startup. No instance is hard-coded.

On Azure the preferred path is a Tailscale sidecar so the container talks to HA on the LAN (#9, #43). A Nabu Casa URL still works and is what local and `dev` use today. `dev` must not control the real doors.

### No webhooks for doors

Home Assistant's own webhook docs say not to use a webhook to unlock a lock or open a garage door: the endpoint is authenticated only by knowing the webhook id ([Webhook security](https://www.home-assistant.io/docs/automation/trigger/#webhook-security)). Pixel also has no public ingress, so it cannot receive an inbound hook.

Door actions are therefore always *outbound*: a Discord command goes through the dispatcher and `core/home-access.ts`, then one catalogue service call on the authenticated socket. Nothing inbound can unlock. Pixel never unlatches (`lock.open`).

### A non-admin token

A [long-lived access token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token) lasts ten years and carries **all** rights of the user who created it. Home Assistant does not issue scoped tokens ("this token may only call `light.turn_on` on `light.workshop`"). [Administrators](https://www.home-assistant.io/docs/configuration/user-configuration/) can change integrations, users and system settings; a non-admin user cannot.

Pixel therefore uses a **dedicated non-admin** Home Assistant user, created only for this bot. That blocks admin-only commands if the token leaks. Pixel asks `auth/current_user` and warns (logs, Sentry, `/admin status`) if the token belongs to an admin. It does not refuse to start: the warning is a nudge, not a lockout.

Home Assistant can attach entity permissions to groups ([Permissions](https://developers.home-assistant.io/docs/auth_permissions/)). Pixel does not rely on that. Revisit if HA ships scoped tokens or a supported per-entity API policy.

### The allow-list is the real fence

Because the token can call any service its user can, Pixel never offers "any entity". The devices it may touch are a human-written allow-list, `config/home-assistant/devices.yaml` (#38): name, entity, kind, allowed actions, `minTier`. Kinds in `src/core/home-kinds/` decide the HA domain and the exact service each action calls. People cannot pass a service name or extra data.

`inventory.yaml` lists what Home Assistant has so a person can copy an entry into the allow-list. It is never read back, never offered in a command, and grants nothing.

Who may use a listed device is one rule in `core/home-access.ts`: the tier floor to read; the floor plus `ha-admin` or the kind's capability plus an allowed action to act. A refusal is always `HOME_DENIED`.

## Consequences

- A leaked Pixel token can still do anything that non-admin user can do *inside Home Assistant* (every light, lock and script that user can see). Revoke it in HA at once; Pixel's allow-list only limits what Pixel will send.
- A taken-over Discord account of someone with `ha-doors` or `ha-admin` can unlock a listed door. Identification is by Discord ID, so a matching name is irrelevant. Mitigations: member-only doors, an explicit capability, `/admin doors off`, audit logs, and revoking the HA token. There is no confirmation step, public notice or "only while the space is open" condition yet (#29 left those out on purpose).
- Pointing `HOME_ASSISTANT_URL` at the real instance from `dev` would let the test bot control the building. Don't.
- Adding a kind is a code change (`src/core/home-kinds/`, `HOME_KINDS`), with tests and a human reviewer. The devices file cannot invent a service.
- Changing how Pixel reaches HA (Nabu Casa → Tailscale, or a new URL) is config, not a new client.
