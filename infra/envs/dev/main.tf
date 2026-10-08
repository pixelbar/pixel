module "pixel" {
  source = "../../modules/pixel"

  environment                          = "dev"
  prefix                               = var.prefix
  resource_group_name                  = "${var.prefix}-dev"
  key_vault_name                       = var.key_vault_name
  data_storage_account_name            = var.data_storage_account_name
  container_image                      = var.container_image
  discord_app_id                       = var.discord_app_id
  discord_guild_id                     = var.discord_guild_id
  discord_announcements_channel_id     = var.discord_announcements_channel_id
  discord_announce_live_channel_id     = var.discord_announce_live_channel_id
  discord_announce_timeline_channel_id = var.discord_announce_timeline_channel_id
  discord_announce_bot_channel_id      = var.discord_announce_bot_channel_id
  discord_role_member                  = var.discord_role_member
  discord_role_friend                  = var.discord_role_friend
  home_assistant_url                   = var.home_assistant_url
  sentry_enabled                       = var.sentry_enabled
  tailscale_enabled                    = var.tailscale_enabled
  tailscale_image                      = var.tailscale_image
  purge_protection_enabled             = false
}
