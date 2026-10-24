# 0018. A signed webhook from the space state service, as a nudge to read SpaceAPI

* Status: accepted (amends "no public ingress" in [ADR 0004](0004-azure-container-apps.md) and [ADR 0009](0009-container-apps-dev.md))
* Date: 2026-10-20

## Context

Pixel learns that the space opened or closed by polling SpaceAPI every 30 seconds, then confirms the change on the next poll before announcing it (`READINGS_TO_CONFIRM`). So an announcement goes out 30 to 60 seconds after the switch is flipped. The space state service ([`pixelbar/spacestate`](https://github.com/pixelbar/spacestate)) knows the moment the state changes, and can tell Pixel.

Until now Pixel had no public ingress at all: everything it does is outbound. Taking a webhook means opening an endpoint to the internet for the first time.

## Decision

- **The webhook is a nudge, not a source of truth.** An accepted call makes Pixel read SpaceAPI again at once (`SpaceStatus.recheck()`). Nothing in the body is used, logged or echoed. The state, and when it changed, still come only from SpaceAPI, so a forged or replayed call can do no more than cause one extra read, and the webhook and SpaceAPI can never disagree about what Pixel announces.
- **`recheck()` never reuses a read that was already under way**, because that read may have started before the change. It waits for it and starts a fresh one. Rechecks that arrive during the same read share the fresh one.
- **A change the webhook pointed out is confirmed after 5 seconds** (`PUSH_CONFIRM_MS`), with a second SpaceAPI read, instead of after a whole poll interval. A switch flicked back sends its own webhook, which resets the wait, so the flicker protection still holds. A change Pixel finds by polling is confirmed as before.
- **Polling stays exactly as it was.** If a webhook is lost, the next poll catches the change and it is announced the usual way, 30 to 60 seconds late.
- **Every request is signed.** The sender and Pixel share `SPACESTATE_WEBHOOK_SECRET` (at least 32 characters; Key Vault `spacestate-webhook-secret`, app group). The contract:

  ```
  POST /hooks/space-state
  X-Spacestate-Timestamp: <unix seconds when sent>
  X-Spacestate-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the secret>
  Content-Type: application/json            (the body is not read; send {"state":"open"} or similar)
  ```

  Pixel answers `202` when it accepts the call, `401` for a missing, malformed, stale (more than 5 minutes either way) or wrong signature, `404` for any other path, `405` for anything but POST, and `413` for a body over 4 KiB. The answer never says why a call was refused; Pixel's log does (`webhook.rejected` with a `reason`). The sender should send once, with a short timeout, and not retry: polling is the retry. A test vector is in `src/adapters/webhook/signature.test.ts`.
- **Its own port.** The webhook listens on `WEBHOOK_PORT` (8081), and only when the secret is set. Azure ingress targets only that port, so `/healthz` and `/readyz` (8080) stay private. Config refuses to put both on the same port.
- **Ingress is opt-in per stack.** `spacestate_webhook_enabled` turns on external HTTPS ingress (`allow_insecure_connections = false`, Azure terminates TLS) and wires the secret. `webhook_allowed_ip_ranges` can limit it to the sender's addresses. The URL is the `spacestate_webhook_url` output. Ingress does not change scaling: `min_replicas = max_replicas = 1` still holds.
- **A custom hostname, optionally.** `custom_domain` (prod: `pixel.pixelbar.nl`) binds a hostname to the same ingress with an Azure-managed certificate (`infra/modules/pixel/domain.tf`). pixelbar.nl's DNS is at TransIP, outside Azure, so it takes two applies: the first only prints the `asuid.` TXT and CNAME records (`custom_domain_dns_records`); `bind_custom_domain = true` issues the certificate (CNAME validation, the same record the binding needs) and binds it once they resolve. Then `spacestate_webhook_url` uses the hostname, which survives the app or its environment being recreated, unlike the generated `*.azurecontainerapps.io` address. The generated address keeps working too.
- **Only `/hooks/` is traced in Sentry.** Probes and whatever else the internet sends to the public port are not, so scanners don't spend the trace quota.

## Consequences

- Pixel has a public address when the webhook is on. The code behind it is small (`src/adapters/webhook/`), checks the signature before doing anything, caps the body, times out slow senders, and has strict coverage floors.
- Rotating the secret means changing it in both places at once. Until both agree, webhooks are refused with `401` and Pixel falls back to polling; nothing breaks.
- The space state service needs to send the webhook. Until it does, or while SpaceAPI is still served by something other than that service, nothing changes: Pixel polls.
- During a deploy, a webhook can reach the old or the new revision, or neither while they swap. Any of those is fine: the next poll catches up.
- Home Assistant still has no inbound webhooks ([ADR 0011](0011-home-assistant.md)). That decision was about acting on devices on the say-so of a URL; this webhook acts on nothing.
