# Copy to terraform.tfvars and replace the fake Discord IDs with Pixel Dev.
# terraform.tfvars is gitignored.
#
# To write Key Vault secrets at apply (values are ephemeral / write-only and
# are not stored in state), set write_secrets = true and the inputs below in
# terraform.tfvars — never in this example file. CI plans with this file.

subscription_id           = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
prefix                    = "pixel"
key_vault_name            = "pixel-dev-kv"
data_storage_account_name = "pixeldevdata"
container_image           = "ghcr.io/pixelbar/pixel:main"

# Until a maintainer makes ghcr.io/pixelbar/pixel public in the GitHub UI,
# Azure cannot pull it (401). Set these and Key Vault secret ghcr-pull-token.
# container_registry_server   = "ghcr.io"
# container_registry_username = "your-github-username"

# Obviously fake. Never commit real Discord IDs.
discord_app_id   = "100000000000000001"
discord_guild_id = "100000000000000002"

# Optional. Leave null / commented until the test-guild channels exist.
# discord_announcements_channel_id = "100000000000000003"

# Nabu Casa still works without Tailscale. Set the matching Key Vault secret
# home-assistant-token as well, or leave both unset (HA off).
# home_assistant_url = "https://example.ui.nabu.casa"

sentry_enabled    = false
tailscale_enabled = false

# Leave false here. Real apply: write_secrets = true plus gitignored values.
# write_secrets   = true
# secrets_version = 1
# discord_token   = "..."
# admins_yaml_file = "../../../config/admins.yaml"
# home_assistant_token = "..."
# sentry_dsn           = "..."
# tailscale_auth_key   = "..."
# container_registry_password = "..."
