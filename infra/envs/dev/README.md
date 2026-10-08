# Pixel `dev` environment (#9)

One Container App in the existing `pixel-dev` resource group. Pixel Dev bot, test guild. **Do not apply until a maintainer says so.** Applying this does not by itself make Discord answer: secrets and volume files still have to be filled in, and you must not start a second bot on the same token.

Prod is #12. This root only calls `infra/modules/pixel` with `environment = "dev"`.

Remote state: storage `pixelbartfstate`, container `dev` (created by bootstrap).

## What it creates

Inside `pixel-dev` (already exists; not recreated):

| Resource | Name (defaults) |
| --- | --- |
| User-assigned identity | `pixel-dev-app` |
| Key Vault (RBAC, no secret values in state) | `pixel-dev-kv` |
| Log Analytics (30-day retention, pending #7) | `pixel-dev-logs` |
| Container Apps environment | `pixel-dev-cae` |
| Container App, min=max replicas **1**, no public ingress | `pixel-dev` |
| Azure Files account + share `pixel` | `pixeldevdata` |
| Daily file-share backup, 14-day keep | `pixel-dev-rsv` |

Optional Tailscale sidecar (off by default): same replica, userspace networking. Nabu Casa (`HOME_ASSISTANT_URL`) still works when it is off. The app sets `PIXEL_RUNTIME=cloud` so `/admin status` and the online post show **Where: cloud**.

There is **no database**.

## Before you apply

1. Bootstrap is applied ([`infra/bootstrap/README.md`](../../bootstrap/README.md)).
2. Azure CLI, signed in as someone who can write role assignments on `pixel-dev` (Owner, or Contributor plus the custom role used for bootstrap).
3. Terraform 1.11+ (`just tf-validate` uses 1.16.5, same as CI). Write-only secret inputs need 1.11.
4. Copy `terraform.example.tfvars` to `terraform.tfvars` (gitignored) and put the **Pixel Dev** application ID and test guild ID. Secret values belong in that gitignored file with `write_secrets = true`, or in `TF_VAR_*` — never in `terraform.example.tfvars`.
5. Register providers once per subscription if they are not already:

   ```sh
   az provider register --namespace Microsoft.App
   az provider register --namespace Microsoft.KeyVault
   az provider register --namespace Microsoft.OperationalInsights
   az provider register --namespace Microsoft.RecoveryServices
   ```

## Apply (when a maintainer says so)

From the repository root:

```sh
just tf-validate
just tf-plan dev
just tf-apply dev
```

The Container App references Key Vault secrets by URI. Values are either **ephemeral apply inputs** (`write_secrets = true`, not stored in state) or set later with `az` / the portal. `terraform.example.tfvars` leaves `write_secrets` off so CI plan cannot clobber a real vault.

Do not run Pixel locally against the same Discord token while this app is up.

## Secrets (Key Vault)

**Preferred for a local apply:** gitignored `terraform.tfvars` (or `TF_VAR_discord_token`). Values are write-only and are not stored in Terraform state.

```hcl
write_secrets    = true
secrets_version  = 1
discord_token    = "..."
admins_yaml_file = "../../../config/admins.yaml"
```

Bump `secrets_version` to rotate. HA / Sentry / Tailscale use `home_assistant_token`, `sentry_dsn`, and `tailscale_auth_key` the same way when those features are on.

**Without `write_secrets`:** create the names yourself, then apply again:

```sh
vault=$(terraform -chdir=infra/envs/dev output -raw key_vault_name)

az keyvault secret set --vault-name "$vault" --name discord-token --file -   # paste token, Ctrl-D
az keyvault secret set --vault-name "$vault" --name admins-yaml --file config/admins.yaml
# If GHCR is still private:
# az keyvault secret set --vault-name "$vault" --name ghcr-pull-token --file -
```

Never commit secret values. Never put them in `terraform.example.tfvars`.

`admins.yaml` is mounted read-only at `/app/secrets/admins-yaml`. After changing it, bump `secrets_version` and re-apply, or set the secret with `az` and restart the Container App. Key Vault versions keep history. Azure Container Apps secret volumes also expose the other secrets as files in `/app/secrets/`; treat that directory as private.

## Volume files (Azure Files)

The share is mounted at `/app/persist` as uid 1000 (`node`). Layout:

| Path in share | Pixel setting | Notes |
| --- | --- | --- |
| `members.yaml` | `PIXEL_MEMBERS_FILE` | Writable; admin commands rewrite it |
| `home-assistant/` | `PIXEL_HOME_ASSISTANT_DIR` | `devices.yaml` (hand), `inventory.yaml` (Pixel) |
| `data/` | `PIXEL_DATA_DIR` | `schedules.yaml` must persist; `home-switches.state` lost → doors start **off** |

Seed after the storage account exists, before Pixel can start (it fails closed without `members.yaml`):

```sh
account=$(terraform -chdir=infra/envs/dev output -raw data_storage_account_name)
az storage file upload --auth-mode login --account-name "$account" --share-name pixel --source config/members.yaml --path members.yaml
az storage file upload-batch --auth-mode login --account-name "$account" --destination pixel/home-assistant --source config/home-assistant --pattern '*.yaml'
```

Do not upload example files that contain fake IDs into a bot that real people will use; use the real Dev access lists.

Daily Azure Backup of the share keeps 14 days. Soft-delete on the share is 14 days as well.

## Confirm `node` can write

After the app is running:

```sh
az containerapp exec -g pixel-dev -n pixel-dev --command /bin/sh
# then:
touch /app/persist/data/.write-test && rm /app/persist/data/.write-test
```

If that fails, the Azure Files uid map did not take. Check `mount_options` on the persist volume (`uid=1000,gid=1000,…`).

## Home Assistant

- **Preferred:** `tailscale_enabled = true` plus Key Vault `tailscale-auth-key` (tagged, reusable or ephemeral). Sidecar is userspace (no TUN). Pixel still uses `HOME_ASSISTANT_URL` + `HOME_ASSISTANT_TOKEN` (both or neither). LAN MagicDNS through the sidecar is remaining work for #43.
- **Works today:** a Nabu Casa URL in `home_assistant_url` and the token in Key Vault, with Tailscale off.

Dev must not control the real doors. Use a test HA, or leave HA off.

## After apply, Discord still will not answer until

1. Key Vault secrets exist (at least `discord-token` and `admins-yaml`), via `write_secrets` or `az`.
2. `members.yaml` (and HA files if used) are on the share.
3. The image exists (`ghcr.io/pixelbar/pixel:<sha>`). If that GHCR package is still **private**, set `container_registry_server` / `container_registry_username` and create Key Vault `ghcr-pull-token` (a `read:packages` token; Azure otherwise gets 401).
4. `just register` has been run against the Dev guild (or #10 does it).
5. Nobody else is connected with that bot token.

Then: `az containerapp revision list -g pixel-dev -n pixel-dev -o table` should show one replica. `/ping` in the test guild.

## Tear down

```sh
terraform -chdir=infra/envs/dev destroy
```

Key Vault soft-delete is 7 days; this env purges on destroy. The resource group `pixel-dev` stays (bootstrap owns it). Recovery Services vaults can take extra time to delete.

## Cost (rough, West Europe, always-on)

About **€40–55/month** for this always-on 0.5 vCPU / 1 Gi replica, Log Analytics, Key Vault, 5 Gi Azure Files and backup. Tailscale adds about **€15** (extra 0.25 vCPU / 0.5 Gi). Actual bills depend on log volume. Not a quote.

## What this is not

- Not GHCR publish or prod CD (#10 / #12). `just deploy-dev` rolls this app.
- Not stop-then-start during deploys (#11). This stack only pins min=max replicas to 1 and `revision_mode = Single`.
- Not `prod` (#12).
- Not Postgres.
