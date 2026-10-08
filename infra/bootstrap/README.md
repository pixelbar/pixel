# Terraform bootstrap (#8)

One-time foundation: remote state in Azure Storage, and GitHub Actions identities that can log in to Azure without a client secret.

This stack is applied **by hand**, from a laptop, by someone with **Owner** on the Pixel subscription. CD (#10) does not apply it.

Do not put secrets in `*.tfvars` or in state. The subscription ID is not a secret.

## What it creates

In West Europe, subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`:

| Resource | Name |
| --- | --- |
| Resource groups | `pixel-bootstrap`, `pixel-dev`, `pixel-prod` |
| Storage account | `pixelbartfstate` (no shared keys, versioning, 14-day soft delete, GRS) |
| Blob containers | `bootstrap`, `dev`, `prod` |
| User-assigned identities | `pixel-github-dev`, `pixel-github-prod` |

Each GitHub identity can federate only from this repository’s matching GitHub Environment (`dev` or `prod`). It is Contributor on that environment’s resource group, and can read/write that environment’s state container. It cannot use the other environment’s group or container.

`pixel-dev` and `pixel-prod` stay as the env resource groups. #9 deploys *into* `pixel-dev`; it does not recreate them.

## Before you apply

1. [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and [Terraform](https://developer.hashicorp.com/terraform/install) 1.9 or later (`just tf-validate` checks the version CI uses).
2. Sign in as someone who is **Owner** of the Pixel subscription:

   ```sh
   az login
   az account set --subscription d150e252-e2f0-47fb-8a4a-c3f29e9aebd4
   az account show --query '{name:name,id:id,user:user.name}' -o json
   ```

3. In the GitHub repo: **Settings → Environments**. Create `dev` and `prod` if they are missing. On `prod`, require reviewers (and limit the deploying branch to `main`) before anything in #10 can use it. The federated subject is `repo:pixelbar/pixel:environment:<name>`, so a workflow that does not use that environment cannot log in.

## Apply

From the repository root (needs Azure CLI, signed in as Owner or Contributor plus a role that can write role assignments):

```sh
just tf-validate
cd infra/bootstrap
terraform init -backend-config=backend.azurerm.example.hcl
terraform plan
terraform apply
```

The first apply on a new subscription has a chicken-and-egg: the storage account does not exist yet. Apply once with `-backend=false` (local state), then:

```sh
terraform init -migrate-state -force-copy -backend-config=backend.azurerm.example.hcl
```

Later applies use the remote backend. Defaults match Pixel. Override with `terraform.tfvars` (gitignored) only if the storage account name is taken.

`terraform apply` prints `tenant_id` and `github_client_ids`. Keep that output. Do not commit `terraform.tfstate` or `tfplan`.

## GitHub variables (not secrets)

In each GitHub Environment (`dev`, `prod`), set **variables** (not secrets). Applied bootstrap values:

| Variable | `dev` | `prod` |
| --- | --- | --- |
| `ARM_CLIENT_ID` | `8cb13b94-5941-4788-8071-9f1ba80dada8` | `7cb1d0a8-5314-4c9b-a0ba-10f5c75367d7` |
| `ARM_TENANT_ID` | `2cd2bab0-0dd0-41ff-8f13-592500857ea6` | same |
| `ARM_SUBSCRIPTION_ID` | `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4` | same |

Create Environment `prod` if it is missing (reviewers, deploying branch `main`). Terraform plan on PRs uses Environment `dev` and **fails closed** without `ARM_*`. Do not store an Azure client secret.

Azure `dev` image rollouts are `just deploy-dev` with local `az`, not these variables. [CD](../../.github/workflows/cd.yml) on `main` publishes GHCR only until #12 — it does not Azure-login or update `pixel-prod`.

## Recover

- **Lost local state before migration:** do not apply again blindly. Import the resource groups and storage account, or rebuild this stack in an empty subscription only if nothing else exists.
- **Lost remote state:** the storage account has versioning and 14-day blob soft delete. Restore the previous `terraform.tfstate` blob.
- **Revoke GitHub’s Azure access:** delete the federated credential or the user-assigned identity. Workflows fail closed; there is no leftover password.

## What this is not

- Not the Container App, volume, Key Vault, or Tailscale sidecar (`infra/envs/dev`, #9 / #43).
- Not the Container App image rollout (`just deploy-dev` for `dev`; [CD](../../.github/workflows/cd.yml) on `main` publishes GHCR only until #12).
- Not Postgres. Pixel’s state is files on a volume.
