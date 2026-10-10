# 0011. Tailscale sidecar: userspace SOCKS5 and localhost HA proxy

* Status: accepted
* Date: 2026-10-09
* Issue: #74

## Context

ADR 0009 added an optional Tailscale sidecar (`tailscale_enabled`, userspace, no TUN) so Azure Pixel can reach Home Assistant without a public URL. The stub was not enough to turn on: Container Apps has no TUN, userspace does not install `100.x` routes, ACA injects `KUBERNETES_SERVICE_HOST` so official `containerboot` dies, and `--accept-routes` / `TS_ACCEPT_DNS` were the wrong defaults.

Nabu Casa still works when the sidecar is off. Pixel’s HA client is unchanged: fail closed, not on `/healthz` / `/readyz`.

## Decision

- **One replica**, extra **containers** on it (`tailscale` + `ha-proxy`). Extra replicas would double-answer Discord and register a second tailnet node.
- **Userspace** (`TS_USERSPACE=true`) plus **SOCKS5** on `127.0.0.1:1055`. No TUN, no VNet, no `--accept-routes`.
- **`ha-proxy`** (pinned socat) listens on `127.0.0.1:8123` and SOCKS5s to `home_assistant_mesh_host:8123`. When Tailscale is on, Pixel’s `HOME_ASSISTANT_URL` is **`http://127.0.0.1:8123`**. Never a `*.ts.net` or `100.x` in the Pixel container (public DNS would blackhole via Azure egress).
- **One URL.** No automatic fallback to Nabu Casa while the mesh is on (that would fail-open to the internet). Unset `home_assistant_url` when enabling Tailscale.
- Clear **`KUBERNETES_SERVICE_HOST`** and **`TS_KUBE_SECRET`**. Advertise `tag:pixel-<env>`. Do not persist Tailscale state on Azure Files while #11 is open (ephemeral / OAuth-minted nodes).
- **Do not ACA-probe** Tailscale `/healthz`. Pixel probes stay Discord-only. HA unavailability stays application fail-closed.
- Enable only in **gitignored** `terraform.tfvars` after Key Vault `tailscale-auth-key` exists. Example tfvars stay `tailscale_enabled = false`.
- Tailnet ACL: Pixel tags may open **tcp:8123** to the HA tag only. Dev must not be granted prod doors.

## Consequences

- Flipping `tailscale_enabled` in gitignored tfvars is the operator step; this module is safe to apply with it still false.
- `ha-proxy` costs a full ACA consumption increment (0.25 vCPU / 0.5 Gi), same floor as Tailscale.
- Application code does not change. Local/Mini Pixel still uses `.env` `HOME_ASSISTANT_URL` as today.
