# Pixel infrastructure

Terraform for Pixel on Azure. There is **no database**. Secret *values* never go in Terraform variables or state.

| Path | What | Issue |
| --- | --- | --- |
| [`bootstrap/`](bootstrap/) | Remote state storage and GitHub → Azure OIDC. Apply this by hand, once. | #8 |
| [`modules/pixel/`](modules/pixel/) | Container App, Azure Files volume, Key Vault, optional Tailscale sidecar. | #9 |
| [`envs/dev/`](envs/dev/) | Dev root: Pixel Dev bot, test guild, into `pixel-dev`. | #9 |
| `envs/prod` | Same module, Pixelbar guild. Not in this PR. | #12 |

Region is West Europe. The Azure subscription is in bootstrap / env variables.

- Bootstrap: [`bootstrap/README.md`](bootstrap/README.md)
- Dev: [`envs/dev/README.md`](envs/dev/README.md)
- Runbook: [Terraform bootstrap](../docs/runbook.md#terraform-bootstrap) and [Azure Container App (`dev`)](../docs/runbook.md#azure-container-app-dev)

`just tf-validate`, `just tf-plan dev`, `just tf-apply dev`. Images and Container App rollouts: `just deploy-dev` for Azure `dev`; [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) on `main` for prod. CD does not apply Terraform.
