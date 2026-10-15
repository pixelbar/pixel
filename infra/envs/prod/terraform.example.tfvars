# Copy to terraform.tfvars and replace the fake Discord IDs with the
# **production** Pixel application and guild. terraform.tfvars is gitignored.
#
# Never copy pixel-dev-kv, the Mini .env, or the Pixel Dev bot token here.
# Prod is a separate Discord application.
#
# CI plans with this file. Leave write_secrets off so plan cannot clobber a
# real vault.

subscription_id           = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
prefix                    = "pixel"
key_vault_name            = "pixel-prod-kv"
data_storage_account_name = "pixelproddata"
# First create and later apply both set this (no ignore_changes on prod).
# Prefer a SHA already on GHCR from main, not a local rebuild.
container_image = "ghcr.io/pixelbar/pixel:main"

# Obviously fake. Never commit real Discord IDs.
discord_app_id   = "100000000000000001"
discord_guild_id = "100000000000000002"

# Optional. Leave null / commented until the prod guild channels exist.
# discord_announcements_channel_id = "100000000000000003"

# Home Assistant and Mastodon stay off until prod has its own tokens.
# home_assistant_url = "https://example.ui.nabu.casa"
# mastodon_instance  = "https://mastodon.example"
# /spacestate: also needs Key Vault secrets spacestate-user and spacestate-token.
# spacestate_api_url = "https://space.example/api/state"

# Lets the Release workflow read discord-token (only) and register slash
# commands (ADR 0014). az identity show -g pixel-bootstrap -n pixel-github-prod --query principalId -o tsv
# github_register_principal_id = "00000000-0000-0000-0000-000000000000"

sentry_enabled    = false
tailscale_enabled = false

# Leave false here. Real apply: write_secrets = true plus gitignored values.
# Never paste the Pixel Dev token.
# write_secrets    = true
# secrets_version  = 1
# discord_token    = "..."
# admins_yaml_file = "../../../config/admins.yaml"
# sentry_dsn       = "..."
