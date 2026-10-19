# 0017. Only the sync tool writes app secrets

* Status: accepted (narrows [ADR 0016](0016-secrets-sync.md))
* Date: 2026-10-15

## Context

After [ADR 0016](0016-secrets-sync.md), two things wrote the manifest's `app` secrets into Key Vault: `just secrets-push` / `just push`, and Terraform's `write_secrets` path, which created `azurerm_key_vault_secret.managed` for every enabled secret except the `tooling` group. They collided. Turning on a feature (`spacestate_api_url`) made Terraform demand the new values as inputs and fail with "Resource precondition failed" when they lived only in `.env.prod`; when the tool had already created them, Terraform failed with "already exists, needs to be imported". A prod apply failed this way on 2026-10-15 over `spacestate-user` and `spacestate-token`.

## Decision

- **`just secrets-push` / `just push` are the only writers of the `app` group** (`discord-token`, `admins-yaml`, `home-assistant-token`, `mastodon-access-token`, `spacestate-user`, `spacestate-token`, `spacestate-additional-headers`, `sentry-dsn`).
- **Terraform's `write_secrets` writes only the `infra` group** (`tailscale-auth-key`, `ghcr-pull-token`): `azurerm_key_vault_secret.infra`, whose `for_each` (`kv_infra_secret_names` in `locals.tf`) is derived from the manifest.
- **The Container App still references every enabled secret** (`key_vault_secret_ids`), app group included. Only the writing moved.
- **The app-group Terraform inputs are gone** (`discord_token`, `admins_yaml`, `admins_yaml_file`, `home_assistant_token`, `mastodon_access_token`, `spacestate_user`, `spacestate_token`, `spacestate_additional_headers`, `sentry_dsn`), from the module and both stacks, so there is no way to set them through Terraform. An old `secrets.auto.tfvars` that still sets them only gets an "undeclared variable" warning; delete those lines.
- **Moving state, deleting nothing.** `moved` blocks carry `managed["tailscale-auth-key"]` and `managed["ghcr-pull-token"]` to `infra[...]`. A `removed` block with `lifecycle { destroy = false }` drops whatever is left under `azurerm_key_vault_secret.managed` (the app secrets) from state and leaves them in Key Vault. `removed` can't name single instances, so the infra keys are moved out first. Keep both until every stack has applied them.

## Consequences

- The next `just tf-plan dev|prod` shows each app secret Terraform had written as "will no longer be managed by Terraform, but will not be destroyed", any infra secret it had written as "has moved to", and no `destroy` for a Key Vault secret. Anything else in that plan is unrelated to this change.
- Turning on a feature that needs an app secret is: `just secrets-push <env>` first, then set the feature in the tfvars and apply. The apply only references the secret; the Container App won't start a revision until it exists.
- `write_secrets = true` still needs the infra inputs (`tailscale_auth_key`, `container_registry_password`) for the infra features that are on, and turning it off later removes the infra secrets Terraform wrote from Key Vault, as before. Keep it on while Terraform owns them, or set them with `az` and leave it off from the start.
- The Release workflow's identity may read `discord-token` (ADR 0014). That role assignment is scoped to the secret, so push `discord-token` before the first apply that sets `github_register_principal_id`.
- `scripts/secrets-manifest.test.ts` fails if Terraform's write map names an app secret, or if the `removed` block goes missing.
