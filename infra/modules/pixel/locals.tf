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

  kv_secret_names = toset(concat(
    ["discord-token", "admins-yaml"],
    var.home_assistant_url != null ? ["home-assistant-token"] : [],
    var.sentry_enabled ? ["sentry-dsn"] : [],
    var.tailscale_enabled ? ["tailscale-auth-key"] : [],
    var.container_registry_server != null ? ["ghcr-pull-token"] : [],
  ))

  # URIs only. Terraform never reads the secret values into state.
  key_vault_secret_ids = {
    for name in local.kv_secret_names :
    name => "${azurerm_key_vault.this.vault_uri}secrets/${name}"
  }

  pixel_plain_env = merge(
    {
      PIXEL_ENV                = var.environment
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
    var.discord_announce_live_channel_id != null ? { DISCORD_ANNOUNCE_LIVE_CHANNEL_ID = var.discord_announce_live_channel_id } : {},
    var.discord_announce_timeline_channel_id != null ? { DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID = var.discord_announce_timeline_channel_id } : {},
    var.discord_announce_bot_channel_id != null ? { DISCORD_ANNOUNCE_BOT_CHANNEL_ID = var.discord_announce_bot_channel_id } : {},
    var.discord_role_member != null ? { DISCORD_ROLE_MEMBER = var.discord_role_member } : {},
    var.discord_role_friend != null ? { DISCORD_ROLE_FRIEND = var.discord_role_friend } : {},
    var.home_assistant_url != null ? { HOME_ASSISTANT_URL = var.home_assistant_url } : {},
  )

  pixel_secret_env = merge(
    { DISCORD_TOKEN = "discord-token" },
    var.home_assistant_url != null ? { HOME_ASSISTANT_TOKEN = "home-assistant-token" } : {},
    var.sentry_enabled ? { SENTRY_DSN = "sentry-dsn" } : {},
  )
}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}
