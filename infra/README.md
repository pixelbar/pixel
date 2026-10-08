# Pixel infrastructure

Terraform for Pixel on Azure. There is **no database**. Secrets never go in Terraform variables or state.

| Path | What | Issue |
| --- | --- | --- |
| [`bootstrap/`](bootstrap/) | Remote state storage and GitHub → Azure OIDC. Apply this by hand, once. | #8 |
| `modules/pixel/` | Container Apps, volume, Key Vault. Not in this PR. | #9 |
| `envs/dev`, `envs/prod` | Per-environment roots that call the module. Not in this PR. | #9, #12 |

Region is West Europe. The Azure subscription is in `bootstrap` variables.

How to apply the bootstrap: [`bootstrap/README.md`](bootstrap/README.md) and the [runbook](../docs/runbook.md#terraform-bootstrap).

Images and Container App rollouts: `just deploy-dev` for Azure `dev`; [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) on `main` for prod. Neither applies Terraform.
