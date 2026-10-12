# Pixel environment module

Reusable Terraform for one Pixel environment (Container App, Azure Files volume, Key Vault, optional Tailscale sidecar). Called from `infra/envs/dev` and `infra/envs/prod`.

Secret values may be passed as ephemeral write-only inputs (`write_secrets`); they are never stored in state. Max replicas is 1. No database. On **dev**, after first create, apply ignores the Pixel container image (`just deploy-dev` / `az` owns the pin). On **prod** (#12), apply sets `container_image`.

See [`infra/envs/dev/README.md`](../../envs/dev/README.md) and [ADR 0009](../../../docs/adr/0009-container-apps-dev.md).
