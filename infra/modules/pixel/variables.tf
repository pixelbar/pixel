variable "environment" {
  type        = string
  description = "Pixel environment name. Becomes PIXEL_ENV and part of resource names. prod is #12."

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "prefix" {
  type        = string
  description = "Name prefix. Must match the bootstrap prefix (pixel)."
  default     = "pixel"

  validation {
    condition     = can(regex("^[a-z0-9]{2,10}$", var.prefix))
    error_message = "prefix must be 2–10 lowercase letters or digits."
  }
}

variable "resource_group_name" {
  type        = string
  description = "Existing environment resource group from bootstrap (pixel-dev or pixel-prod). This module does not create it."
}

variable "key_vault_name" {
  type        = string
  description = "Globally unique Key Vault name (3–24 letters, digits or hyphens)."

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]{3,24}$", var.key_vault_name))
    error_message = "key_vault_name must be 3–24 letters, digits or hyphens."
  }
}

variable "data_storage_account_name" {
  type        = string
  description = "Globally unique storage account for the Azure Files volume (3–24 lowercase letters or digits). Not the Terraform state account."

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.data_storage_account_name))
    error_message = "data_storage_account_name must be 3–24 lowercase letters or digits."
  }
}

variable "container_image" {
  type        = string
  description = "Container image. #10 publishes ghcr.io/pixelbar/pixel:<sha>. A public GHCR tag is fine for a first apply; the image must not contain secrets or access files."
  default     = "ghcr.io/pixelbar/pixel:main"
}

variable "discord_app_id" {
  type        = string
  description = "Discord application ID for this environment's bot. Not a secret."

  validation {
    condition     = can(regex("^\\d{17,20}$", var.discord_app_id))
    error_message = "discord_app_id must be a Discord ID (17–20 digits)."
  }
}

variable "discord_guild_id" {
  type        = string
  description = "The only guild this environment serves. Not a secret."

  validation {
    condition     = can(regex("^\\d{17,20}$", var.discord_guild_id))
    error_message = "discord_guild_id must be a Discord ID (17–20 digits)."
  }
}

variable "discord_announcements_channel_id" {
  type        = string
  default     = null
  description = "Optional. DISCORD_ANNOUNCEMENTS_CHANNEL_ID."

  validation {
    condition     = var.discord_announcements_channel_id == null || can(regex("^\\d{17,20}$", var.discord_announcements_channel_id))
    error_message = "discord_announcements_channel_id must be a Discord ID or unset."
  }
}

variable "discord_announce_live_channel_id" {
  type        = string
  default     = null
  description = "Optional. DISCORD_ANNOUNCE_LIVE_CHANNEL_ID."

  validation {
    condition     = var.discord_announce_live_channel_id == null || can(regex("^\\d{17,20}$", var.discord_announce_live_channel_id))
    error_message = "discord_announce_live_channel_id must be a Discord ID or unset."
  }
}

variable "discord_announce_timeline_channel_id" {
  type        = string
  default     = null
  description = "Optional. DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID."

  validation {
    condition     = var.discord_announce_timeline_channel_id == null || can(regex("^\\d{17,20}$", var.discord_announce_timeline_channel_id))
    error_message = "discord_announce_timeline_channel_id must be a Discord ID or unset."
  }
}

variable "discord_announce_bot_channel_id" {
  type        = string
  default     = null
  description = "Optional. DISCORD_ANNOUNCE_BOT_CHANNEL_ID."

  validation {
    condition     = var.discord_announce_bot_channel_id == null || can(regex("^\\d{17,20}$", var.discord_announce_bot_channel_id))
    error_message = "discord_announce_bot_channel_id must be a Discord ID or unset."
  }
}

variable "discord_role_member" {
  type        = string
  default     = null
  description = "Optional. Discord role name or ID that member is mirrored to."
}

variable "discord_role_friend" {
  type        = string
  default     = null
  description = "Optional. Discord role name or ID that friend is mirrored to."
}

variable "home_assistant_url" {
  type        = string
  default     = null
  description = "Optional. HOME_ASSISTANT_URL (Nabu Casa or a Tailscale/LAN address). Not a secret. The token is a Key Vault secret. Set both or neither."

  validation {
    condition     = var.home_assistant_url == null || can(regex("^https?://", var.home_assistant_url))
    error_message = "home_assistant_url must be an http(s) URL or unset."
  }
}

variable "sentry_enabled" {
  type        = bool
  default     = false
  description = "If true, the app reads SENTRY_DSN from Key Vault secret sentry-dsn. Create that secret before apply."
}

variable "tailscale_enabled" {
  type        = bool
  default     = false
  description = "Preferred path to Home Assistant: a userspace Tailscale sidecar on the replica. Off until an auth key exists. Nabu Casa still works when this is false."
}

variable "tailscale_image" {
  type        = string
  default     = "ghcr.io/tailscale/tailscale:v1.86.5"
  description = "Tailscale sidecar image. Pin a version; do not use latest."
}

variable "timezone" {
  type        = string
  default     = "Europe/Amsterdam"
  description = "PIXEL_TIMEZONE."
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "Log Analytics retention in days. Provisional until #7 decides the privacy notice period."

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730 (Log Analytics floor is 30)."
  }
}

variable "purge_protection_enabled" {
  type        = bool
  default     = false
  description = "Key Vault purge protection. Leave off on dev so the vault can be torn down; turn on for prod (#12)."
}
