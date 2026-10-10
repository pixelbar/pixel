# Pixel environment module

Reusable Terraform for one Pixel environment (Container App, Azure Files volume, Key Vault, optional userspace Tailscale sidecar + `ha-proxy`). Called from `infra/envs/dev` today; `prod` is #12. See [ADR 0011](../../../docs/adr/0011-tailscale-sidecar.md).

Secret values may be passed as ephemeral write-only inputs (`write_secrets`); they are never stored in state. Max replicas is 1. No database.

See [`infra/envs/dev/README.md`](../../envs/dev/README.md) and [ADR 0009](../../../docs/adr/0009-container-apps-dev.md).
