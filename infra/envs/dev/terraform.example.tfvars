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

# Off-mesh HA (Nabu Casa). Do not set this when tailscale_enabled is true —
# Pixel then uses http://127.0.0.1:8123. Set home-assistant-token as well,
# or leave HA unset.
# home_assistant_url = "https://example.ui.nabu.casa"

sentry_enabled    = false
tailscale_enabled = false

# Mesh HA: enable only in gitignored terraform.tfvars after Key Vault
# tailscale-auth-key exists. Unset home_assistant_url. Do not flip this
# example file on — the old stub was not enough to enable as-is.
# tailscale_enabled          = true
# home_assistant_mesh_host   = "homeassistant"
# # write_secrets requires home_assistant_token and tailscale_auth_key too.

# Leave false here. Real apply: write_secrets = true plus gitignored values.
# write_secrets   = true
# secrets_version = 1
# discord_token   = "..."
# admins_yaml_file = "../../../config/admins.yaml"
# home_assistant_token = "..."
# sentry_dsn           = "..."
# tailscale_auth_key   = "..."
# container_registry_password = "..."
