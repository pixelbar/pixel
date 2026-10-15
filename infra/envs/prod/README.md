# Pixel `prod` environment (#12)

One Container App in the existing `pixel-prod` resource group. Production Pixel bot, production guild. **Coding agents must not apply this stack** (`just tf-apply prod` refuses unless `PIXEL_APPLY_PROD=1`). A maintainer applies it after a separate Discord application, Key Vault secrets, and access lists exist.

Do **not** copy `pixel-dev-kv`, the Mini `.env`, or the Pixel Dev bot token. Dev stays on the test guild.

This root only calls `infra/modules/pixel` with `environment = "prod"` (purge protection on, `azurerm_container_app.managed` so apply sets `container_image`).

Remote state: storage `pixelbartfstate`, container `prod` (created by bootstrap).

## What it creates

Inside `pixel-prod` (already exists; not recreated):

| Resource | Name (defaults) |
| --- | --- |
| User-assigned identity | `pixel-prod-app` |
| Key Vault (RBAC, purge protection **on**) | `pixel-prod-kv` |
| Log Analytics (30-day retention, pending #7) | `pixel-prod-logs` |
| Container Apps environment | `pixel-prod-cae` |
| Container App, min=max replicas **1**, no public ingress | `pixel-prod` |
| Azure Files account + share `pixel` | `pixelproddata` |
| Daily file-share backup, 14-day keep | `pixel-prod-rsv` |

The app sets `PIXEL_RUNTIME=cloud` and `PIXEL_ENV=prod`. There is **no database**.

## Before you apply

1. Bootstrap is applied ([`infra/bootstrap/README.md`](../../bootstrap/README.md)). Prod GitHub OIDC must use the immutable subject (`repo:pixelbar@1690472/pixel@1402859166:environment:prod`, #71).
2. GitHub Environment `prod`: required reviewers, deploying branch `main`, `ARM_*` **variables** (not secrets). Values: bootstrap README.
3. A **new** Discord application (not Pixel Dev). Invite it with scopes `bot` and `applications.commands`. Put that application ID and guild ID in gitignored `terraform.tfvars`. See [Adding Pixel to a Discord server](../../../docs/runbook.md#adding-pixel-to-a-discord-server).
4. Azure CLI, signed in as someone who can write role assignments on `pixel-prod`.
5. Terraform 1.11+ (`just tf-validate` uses 1.16.5, same as CI).
6. `just pull prod` to get the shared `terraform.tfvars` (Key Vault `terraform-tfvars`). The very first time, copy `terraform.example.tfvars` to `terraform.tfvars` and `just push prod`. Secret values go in gitignored `secrets.auto.tfvars` with `write_secrets = true`, or in `TF_VAR_*` — never in `terraform.tfvars`, never from `pixel-dev-kv`.

## Apply (maintainer only)

```sh
just tf-validate
just tf-plan prod
PIXEL_APPLY_PROD=1 just tf-apply prod
```

`container_image` is pinned by apply. After first create, a [Release](../../../.github/workflows/release.yml) (Environment `prod` approval) rolls `pixel-prod` to the released GHCR SHA with `az containerapp update` and does **not** apply Terraform. A later maintainer apply will set `container_image` from tfvars again, so bump that SHA if you apply after a Release has moved on.

## Secrets (Key Vault)

Same names as `dev`. Preferred local apply:

```hcl
write_secrets    = true
secrets_version  = 1
discord_token    = "..."   # production bot only
admins_yaml_file = "../../../config/admins.yaml"  # production list, not Dev
```

Or `az keyvault secret set --vault-name pixel-prod-kv --name discord-token --file -`. Never commit values.

## Volume files

Same layout as `dev` (`members.yaml`, `home-assistant/`, `data/` on share `pixel`). Seed **production** lists, not the example IDs and not a copy of Dev unless you intend that.

```sh
account=$(terraform -chdir=infra/envs/prod output -raw data_storage_account_name)
az storage file upload --auth-mode login --account-name "$account" --share-name pixel --source config/members.yaml --path members.yaml
```

## After apply, Discord still will not answer until

1. Key Vault secrets exist (`discord-token`, `admins-yaml`) for the **prod** bot.
2. `members.yaml` is on the prod share.
3. The image exists (`ghcr.io/pixelbar/pixel:<sha>` from a Release, or the `:main` tag from CD).
4. Commands are registered against the **prod** guild. A Release does this in its `register-prod` job once `github_register_principal_id` is set to `pixel-github-prod`'s principal ID (`az identity show -g pixel-bootstrap -n pixel-github-prod --query principalId -o tsv`) and applied; it can read `discord-token` and nothing else ([ADR 0014](../../../docs/adr/0014-release-registers-commands.md)). By hand: `just register prod` with `.env.prod`, never `.env` or `.env.dev`.
5. Nobody else is connected with that prod token.

Then: `az containerapp replica list -g pixel-prod -n pixel-prod -o table` must show one replica. `/ping` in the production guild.

## What this is not

- Not `just deploy` (it refuses prod: prod ships from the Release workflow).
- Not a clone of `pixel-dev-kv` or the Pixel Dev Discord application.
- Not stop-then-start during deploys (#11).
- Not Postgres.
