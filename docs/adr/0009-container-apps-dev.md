# 0009. Container Apps module and the `dev` environment

* Status: accepted
* Date: 2026-10-08
* Issue: #9

## Context

Bootstrap (#8, ADR 0008) created resource groups, remote state, and GitHub OIDC. Pixel still was not running. This stack deploys the bot into `pixel-dev` as a single Container App. Prod (#12) should be the same module with a different env root.

Ground truth is the architecture Deployment section and the comments on #9, not the original issue body (optional volume, Key Vault for `members.yaml`, and a block-list are all stale).

## Decision

- **`infra/modules/pixel`** describes one environment. **`infra/envs/dev`** calls it. The module does not create the env resource group; it deploys *into* `pixel-dev`. Remote state is the `dev` container on `pixelbartfstate`.
- **Exactly one replica** (`min_replicas = 1`, `max_replicas = 1`), `revision_mode = Single`, no public ingress. Discord needs an always-on process. Two replicas answer every command twice. Overlap during a revision swap is **#11** (stop-then-start). There is no database and no lock.
- **Writable Azure Files volume** (required) at `/app/persist` for `members.yaml`, `config/home-assistant/`, and `PIXEL_DATA_DIR` (`schedules.yaml` must not be lost; `home-switches.state` lost → doors start **off**). Mount options set `uid=1000,gid=1000` so the image's `node` user can write after the mount replaces `/app/data`. Daily Azure Backup of the share, 14-day keep, plus 14-day share soft-delete.
- **`admins.yaml`** is a read-only Key Vault secret, mounted as a file. Admin membership is never changed by a command.
- **Secret values never go in Terraform state.** They may be passed as **ephemeral write-only apply inputs** (`write_secrets = true`, `value_wo` on `azurerm_key_vault_secret`) from gitignored `terraform.tfvars` / `TF_VAR_*`, or set with `az` / the portal. CI plans with `terraform.example.tfvars`, which leaves `write_secrets` off. The Container App references secrets by URI only.
- **Azure Files SMB still needs the storage account key** to register the share on the Container Apps environment. Identity-based mounts are not supported there yet. That key is a platform credential and will appear in state. Pixel tokens and YAML do not. NFS was rejected because it needs a VNet and a premium 100 GiB share.
- **Home Assistant:** a Tailscale sidecar on the replica is the preferred path (`tailscale_enabled`). How that sidecar actually reaches HA (userspace SOCKS5 + `ha-proxy`, not MagicDNS in Pixel) is [ADR 0011](0011-tailscale-sidecar.md) / #74. A Nabu Casa URL still works when Tailscale is off. Both URL and token or neither. Dev must not control the real doors.
- **Images:** `ghcr.io/pixelbar/pixel:<sha>` is #10. First apply may use a public GHCR tag. If the package is still private, the module accepts an optional registry (`container_registry_server` + username + Key Vault `ghcr-pull-token`). The image contains `content/` only.
- **Logs:** Log Analytics, 30 days, until #7 decides retention for the privacy notice.
- **CI:** `just tf-validate` format-checks and validates bootstrap and `envs/dev`. `terraform plan` on `envs/dev` uses GitHub Environment `dev` OIDC and **fails closed** if `ARM_*` is missing. No apply on merge.

## Consequences

- Applying this stack does not make Discord answer until secrets, volume files, and an image exist, and until nobody else uses that bot token.
- GitHub Environments `dev` / `prod` and their `ARM_*` variables are still needed for #10 OIDC, not for writing this Terraform.
- Changing replica count requires editing the module; it is not a variable.
- Prod (#12) is another env root, with purge protection on and no purge-on-destroy.
