# 0016. A laptop tool syncs app secrets with Key Vault

* Status: accepted
* Date: 2026-10-15

## Context

Maintainers set Pixel's secrets in Key Vault by pasting values into gitignored `terraform.tfvars` (with `write_secrets = true`) or by running `az keyvault secret set` one name at a time. Neither shows what's in the vault now, neither says what a change would do before it happens, and it's easy to forget the restart afterwards or to set a secret in the wrong environment's vault. The same tokens already live on the maintainer's laptop in `.env.dev` / `.env.prod` for `just register`. [ADR 0015](0015-secrets-manifest.md) made `infra/secrets.manifest.yaml` the list of secrets and marked the `app` group as the one a sync tool would manage.

## Decision

- **`just secrets-pull dev|prod` and `just secrets-push dev|prod`** ([`scripts/secrets-sync.ts`](../../scripts/secrets-sync.ts)) sync the manifest's `app` secrets between an environment's vault (`pixel-dev-kv`, `pixel-prod-kv`) and the laptop. Env secrets live under their environment variable in `.env.<env>`; `admins-yaml` lives in `config/admins.<env>.yaml`. All are gitignored. `infra` secrets stay with Terraform and the tool never reads them.
- **It follows `just ha-devices`.** Pull reads the vault and writes the local files, asking before it overwrites a local value you haven't pushed. Push reads the vault (the live values), compares, shows what would change and asks. Before it writes it reads the vault again and stops if anything changed meanwhile; after it writes it reads every value back.
- **It never prints a value.** A secret is shown by name and length. `admins.yaml` is IDs, not a token, so its diff is shown, and a push checks it against that environment's `members.yaml` on the file share the way Pixel does at startup.
- **A push never deletes** a secret from the vault, and never sets one from a command-line argument (values go through a private temporary file).
- **Guards.** The env file must say the right `PIXEL_ENV` (the same check as `just register`). A Discord token that's also in another bot's env file (`.env.dev` or `.env` for prod, `.env.prod` for dev) is refused. Pushing to prod also asks you to type `prod`.
- **Restart is offered, not assumed.** Pixel reads secrets once at startup. After a push the tool offers `just restart <env>`, which restarts the running revision (one replica) without deploying anything.

## Consequences

- Terraform's `write_secrets` path still works and still owns the `infra` secrets. If an environment keeps `write_secrets = true` with app values in its tfvars (now `secrets.auto.tfvars`, see the addendum), a later apply that bumps `secrets_version` puts those values back, so keep them up to date or turn `write_secrets` off once the vault is seeded.
- A maintainer needs Key Vault Secrets Officer on the vault (Secrets User is enough to pull), and the same storage access as `just ha-devices` for the `members.yaml` check.
- The local files hold real secrets. They are gitignored and written with mode `0600`; don't copy them anywhere else.
- Coding agents don't run `just secrets-push prod` or `just push prod` (AGENTS.md: no prod secrets).

## Addendum: `just pull` / `just push` and the shared tfvars

Each stack's `terraform.tfvars` lived only on the laptop of whoever last applied, so nobody else could plan or apply. It is now the Key Vault secret `terraform-tfvars` in that environment's vault, in a new manifest group, `tooling` (delivery `tool`): read and written only by the laptop tools. Terraform skips the group, so the Container App never references it.

- **`just pull dev|prod`** pulls the tfvars, the app secrets, and read-only mirrors of the share's `members.yaml`, `devices.yaml` and `announcement-routes.yaml`. **`just push dev|prod`** pushes the tfvars and the app secrets, with the same diff, approve, re-check and read-back as above. The mirrors never go back up: Pixel and `just ha-devices` stay their only writers.
- **The tfvars hold settings, never secrets.** A push refuses one that sets a variable the stack marks `sensitive`, sets one it doesn't declare, or names the other environment's vault or storage account. Secret inputs go in `secrets.auto.tfvars`, which Terraform auto-loads and which never leaves the laptop. So the tfvars diff is shown in full.
- Pushing the tfvars changes nothing on Azure by itself. Plan and apply stay separate steps (and prod stays maintainer-only).
