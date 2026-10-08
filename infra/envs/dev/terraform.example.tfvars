# Copy to terraform.tfvars and replace the fake Discord IDs with Pixel Dev.
# terraform.tfvars is gitignored. None of these values are secrets.
# Tokens, the Tailscale auth key, Sentry DSN and admins.yaml go in Key Vault.

subscription_id           = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
prefix                    = "pixel"
key_vault_name            = "pixel-dev-kv"
data_storage_account_name = "pixeldevdata"
container_image           = "ghcr.io/pixelbar/pixel:main"

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
