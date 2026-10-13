# 0012. Prod environment and approved CD

* Status: accepted
* Date: 2026-10-12
* Issue: #12

## Context

`pixel-dev` is live. Merges to `main` published GHCR but did not log in to Azure (ADR 0010), because there was no `infra/envs/prod` and prod secrets must never be the Mini / Pixel Dev Discord token.

Issue 12 asks for a production Container App, a GitHub Environment approval gate, and go-live in a production Discord guild. Dev keeps its own bot and test guild. Pixel is still one guild per bot (`DISCORD_GUILD_ID`); a second server needs this second application, not a migrate of Pixel Dev.

Prod GitHub OIDC must use the immutable subject `repo:pixelbar@1690472/pixel@1402859166:environment:prod` (#71) before any `azure/login`.

## Decision

- **`infra/envs/prod`** calls the same module as `dev` with `environment = "prod"`: purge protection on, no purge-on-destroy, `azurerm_container_app.managed` so apply sets `container_image`. Resource group `pixel-prod` already exists (bootstrap). Own Key Vault (`pixel-prod-kv`), Files account, Sentry environment, Discord application, and access lists.
- **Never copy** `pixel-dev-kv`, the Mini `.env`, or the Pixel Dev bot token into prod.
- **Apply is maintainer-only.** `just tf-apply prod` refuses unless `PIXEL_APPLY_PROD=1`. Coding agents must not apply prod or write prod secrets. CD does **not** apply Terraform.
- **Promotion:** CD on `main` publishes the image once, then the `prod-cd` job (GitHub Environment `prod`) rolls `pixel-prod` to **that same digest** with `az containerapp update`. It does not rebuild. Approvers should treat Environment `prod` as the gate; required reviewers and branch `main` belong on that Environment. **Superseded by [ADR 0013](0013-release-workflow.md):** promotion is the Release workflow, not every merge to `main`.
- **`just deploy-dev`** still refuses prod names and `PIXEL_ENV=prod`. Dev stays local rolls onto `pixel-dev`.
- **Register** stays a laptop command (`just register prod` with `.env.prod`). CD does not read `pixel-prod-kv` Discord tokens (the GitHub identity is Contributor on the RG, not Key Vault Secrets User).

## Consequences

- Discord on prod stays dark until a maintainer applies `infra/envs/prod`, fills prod secrets and `members.yaml`, invites the **prod** bot (scopes `bot` and `applications.commands`), and registers commands. The test guild and Pixel Dev bot are unchanged.
- A merge to `main` still publishes GHCR. Rolling `pixel-prod` is the Release workflow ([ADR 0013](0013-release-workflow.md)).
- Re-applying terraform after CD has moved the image will pin `container_image` from tfvars; bump that SHA if you apply.
- ADR 0010 still describes `just deploy-dev` and GHCR publish. Its “prod CD off” clause is superseded by this ADR.
