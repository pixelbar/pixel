# Pixel infrastructure

How the hosted pieces fit together (diagrams): [`docs/infra.md`](../docs/infra.md).

Terraform for Pixel on Azure. There is **no database**. Secret *values* never go in state. App secrets are written only by `just secrets-push` ([ADR 0017](../docs/adr/0017-one-writer-for-app-secrets.md)); the infra ones (`tailscale-auth-key`, `ghcr-pull-token`) may be passed as ephemeral write-only apply inputs (`write_secrets`) or set with `az`.

| Path | What | Issue |
| --- | --- | --- |
| [`bootstrap/`](bootstrap/) | Remote state storage and GitHub → Azure OIDC. Apply this by hand, once. | #8 |
| [`modules/pixel/`](modules/pixel/) | Container App, Azure Files volume, Key Vault, optional Tailscale sidecar. | #9 |
| [`envs/dev/`](envs/dev/) | Dev root: Pixel Dev bot, test guild, into `pixel-dev`. | #9 |
| [`envs/prod/`](envs/prod/) | Prod root: production Pixel bot, production guild, into `pixel-prod`. Coding agents must not apply. | #12 |

Region is West Europe. The Azure subscription is in bootstrap / env variables.

- Bootstrap: [`bootstrap/README.md`](bootstrap/README.md)
- Dev: [`envs/dev/README.md`](envs/dev/README.md)
- Prod: [`envs/prod/README.md`](envs/prod/README.md)
- Runbook: [Terraform bootstrap](../docs/runbook.md#terraform-bootstrap), [Azure Container App (`dev`)](../docs/runbook.md#azure-container-app-dev), [Adding Pixel to a Discord server](../docs/runbook.md#adding-pixel-to-a-discord-server)

`just tf-validate`, `just tf-plan dev`, `just tf-apply dev`. Prod: `just tf-plan prod`, `PIXEL_APPLY_PROD=1 just tf-apply prod`. Images: `just deploy dev` for Azure `dev`; a Release after Environment `prod` approval for `pixel-prod`. After first create, **dev** apply ignores the Pixel container image (#73); prod apply sets `container_image`. CD does not apply Terraform.
