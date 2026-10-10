# Pixel infrastructure

How the hosted pieces fit together (diagrams): [`docs/infra.md`](../docs/infra.md).

Terraform for Pixel on Azure. There is **no database**. Secret *values* never go in state. They may be passed as ephemeral write-only apply inputs (`write_secrets`) or set with `az` / the portal.

| Path | What | Issue |
| --- | --- | --- |
| [`bootstrap/`](bootstrap/) | Remote state storage and GitHub → Azure OIDC. Apply this by hand, once. | #8 |
| [`modules/pixel/`](modules/pixel/) | Container App, Azure Files volume, Key Vault, optional Tailscale sidecar + ha-proxy. | #9, #74 |
| [`envs/dev/`](envs/dev/) | Dev root: Pixel Dev bot, test guild, into `pixel-dev`. | #9 |
| `envs/prod` | Same module, Pixelbar guild. Not in this PR. | #12 |

Region is West Europe. The Azure subscription is in bootstrap / env variables.

- Bootstrap: [`bootstrap/README.md`](bootstrap/README.md)
- Dev: [`envs/dev/README.md`](envs/dev/README.md)
- Runbook: [Terraform bootstrap](../docs/runbook.md#terraform-bootstrap) and [Azure Container App (`dev`)](../docs/runbook.md#azure-container-app-dev)

`just tf-validate`, `just tf-plan dev`, `just tf-apply dev`. Images and Container App rollouts: `just deploy-dev` for Azure `dev`. [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) on `main` publishes GHCR only; prod CD is off until #12. CD does not apply Terraform.
