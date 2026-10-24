# Copy to terraform.tfvars and replace the fake Discord IDs with Pixel Dev.
# terraform.tfvars is gitignored.
#
# App secrets (discord-token, admins-yaml, ...) go in Key Vault with
# just secrets-push dev, never through Terraform. CI plans with this file.

subscription_id           = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
prefix                    = "pixel"
key_vault_name            = "pixel-dev-kv"
data_storage_account_name = "pixeldevdata"
# Dev first create only. After that, apply ignores the running Pixel image
# (#73); just deploy-dev / az containerapp update owns the pin. Bumping this
# in gitignored terraform.tfvars will not roll pixel-dev. Prod (#12) apply
# will set container_image (no ignore on that resource).
container_image = "ghcr.io/pixelbar/pixel:main"

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

# Mastodon publisher (outbound). Set the matching Key Vault secret
# mastodon-access-token as well, or leave both unset (off).
# mastodon_instance = "https://mastodon.example"

# /spacestate (set the space open or closed). Set the matching Key Vault
# secrets spacestate-user and spacestate-token as well, or leave all unset (off).
# spacestate_api_url = "https://space.example/api/state"
# spacestate_additional_headers_enabled = true   # also needs Key Vault secret spacestate-additional-headers

# The space state webhook: public HTTPS ingress to port 8081 only (ADR 0018). Push Key
# Vault secret spacestate-webhook-secret first. The URL is the spacestate_webhook_url output.
# spacestate_webhook_enabled = true
# webhook_allowed_ip_ranges  = ["203.0.113.7/32"]   # optional; empty lets anyone try (signed requests only)
# A hostname for it, in two applies: set custom_domain and apply, create the records from
# the custom_domain_dns_records output at TransIP, then set bind_custom_domain and apply.
# custom_domain      = "pixel-dev.pixelbar.nl"
# bind_custom_domain = true

sentry_enabled    = false
tailscale_enabled = false

# write_secrets writes only the infra group (tailscale-auth-key, ghcr-pull-token)
# from gitignored secrets.auto.tfvars, never terraform.tfvars (just push refuses
# it). Leave it false here.
# write_secrets               = true
# secrets_version             = 1
# tailscale_auth_key          = "..."
# container_registry_password = "..."
