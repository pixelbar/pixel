locals {
  name_prefix = "${var.prefix}-${var.environment}"
  location    = data.azurerm_resource_group.this.location

  tags = {
    project = "pixel"
    env     = var.environment
    stack   = "pixel"
  }

  persist_mount = "/app/persist"
  secrets_mount = "/app/secrets"

  # node:24-slim runs as uid/gid 1000. Azure Files replaces /app/data from the
  # image, so the mount must make that user the owner.
  azure_file_mount_options = "uid=1000,gid=1000,dir_mode=0775,file_mode=0664,nobrl,mfsymlinks,cache=none"

  # Which secrets exist, what they are called in Key Vault and which environment variable
  # carries each one live in infra/secrets.manifest.yaml (ADR 0015), not here. This file
  # only says when each feature applies. A feature the manifest names but this map doesn't
  # fails the plan, and scripts/secrets-manifest.test.ts catches it earlier.
  secrets_manifest = yamldecode(file("${path.module}/../../secrets.manifest.yaml"))

  secret_features = {
    always             = true
    home-assistant     = var.home_assistant_url != null
    mastodon           = var.mastodon_instance != null
    spacestate         = var.spacestate_api_url != null
    spacestate-headers = var.spacestate_api_url != null && var.spacestate_additional_headers_enabled
    sentry             = var.sentry_enabled
    tailscale          = var.tailscale_enabled
    container-registry = var.container_registry_server != null
  }

  # The tooling group (terraform-tfvars) is for the laptop tools only: never a Container App
  # secret, never written by Terraform.
  enabled_secrets = [
    for s in local.secrets_manifest.secrets : s
    if s.group != "tooling" && local.secret_features[s.feature]
  ]

  kv_secret_names = toset([for s in local.enabled_secrets : s.vault])

  # The only secrets Terraform writes (write_secrets). The app group is written by
  # just secrets-push / just push alone (ADR 0017); Terraform only references it.
  kv_infra_secret_names = toset([for s in local.enabled_secrets : s.vault if s.group == "infra"])

  # URIs only. Terraform never reads the secret values into state.
  key_vault_secret_ids = {
    for name in local.kv_secret_names :
    name => "${azurerm_key_vault.this.vault_uri}secrets/${name}"
  }

  pixel_plain_env = merge(
    {
      PIXEL_ENV                = var.environment
      PIXEL_RUNTIME            = "cloud"
      PIXEL_ADMINS_FILE        = "${local.secrets_mount}/admins-yaml"
      PIXEL_MEMBERS_FILE       = "${local.persist_mount}/members.yaml"
      PIXEL_DATA_DIR           = "${local.persist_mount}/data"
      PIXEL_HOME_ASSISTANT_DIR = "${local.persist_mount}/home-assistant"
      PIXEL_LOG_DIR            = "${local.persist_mount}/data/logs"
      PIXEL_TIMEZONE           = var.timezone
      HEALTH_PORT              = "8080"
      DISCORD_APP_ID           = var.discord_app_id
      DISCORD_GUILD_ID         = var.discord_guild_id
    },
    var.discord_announcements_channel_id != null ? { DISCORD_ANNOUNCEMENTS_CHANNEL_ID = var.discord_announcements_channel_id } : {},
    var.discord_announce_bot_channel_id != null ? { DISCORD_ANNOUNCE_BOT_CHANNEL_ID = var.discord_announce_bot_channel_id } : {},
    var.discord_closing_time_channel_id != null ? { DISCORD_CLOSING_TIME_CHANNEL_ID = var.discord_closing_time_channel_id } : {},
    var.discord_role_member != null ? { DISCORD_ROLE_MEMBER = var.discord_role_member } : {},
    var.discord_role_friend != null ? { DISCORD_ROLE_FRIEND = var.discord_role_friend } : {},
    var.home_assistant_url != null ? { HOME_ASSISTANT_URL = var.home_assistant_url } : {},
    var.mastodon_instance != null ? { MASTODON_INSTANCE = var.mastodon_instance } : {},
    var.spacestate_api_url != null ? { SPACESTATE_API_URL = var.spacestate_api_url } : {},
  )

  # Environment variable => Key Vault secret name, for what the Pixel container reads from its
  # environment. The Tailscale sidecar and the registry login keep their own wiring.
  pixel_secret_env = {
    for s in local.enabled_secrets : s.env => s.vault
    if s.delivery == "env"
  }
}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}
