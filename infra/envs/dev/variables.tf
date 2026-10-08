variable "subscription_id" {
  type        = string
  description = "Azure subscription for Pixel. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "prefix" {
  type        = string
  description = "Name prefix. Must match bootstrap."
  default     = "pixel"

  validation {
    condition     = can(regex("^[a-z0-9]{2,10}$", var.prefix))
    error_message = "prefix must be 2–10 lowercase letters or digits."
  }
}

variable "key_vault_name" {
  type        = string
  description = "Globally unique Key Vault name."
  default     = "pixel-dev-kv"

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]{3,24}$", var.key_vault_name))
    error_message = "key_vault_name must be 3–24 letters, digits or hyphens."
  }
}

variable "data_storage_account_name" {
  type        = string
  description = "Globally unique storage account for the Azure Files volume. Not the Terraform state account."
  default     = "pixeldevdata"

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.data_storage_account_name))
    error_message = "data_storage_account_name must be 3–24 lowercase letters or digits."
  }
}

variable "container_image" {
  type        = string
  description = "Image for the Pixel container. #10 publishes ghcr.io/pixelbar/pixel:<sha>."
  default     = "ghcr.io/pixelbar/pixel:main"
}

variable "discord_app_id" {
  type        = string
  description = "Pixel Dev application ID. Not a secret. Real value in terraform.tfvars (gitignored)."
}

variable "discord_guild_id" {
  type        = string
  description = "Test guild ID. Not a secret. Real value in terraform.tfvars (gitignored)."
}

variable "discord_announcements_channel_id" {
  type    = string
  default = null
}

variable "discord_announce_live_channel_id" {
  type    = string
  default = null
}

variable "discord_announce_timeline_channel_id" {
  type    = string
  default = null
}

variable "discord_announce_bot_channel_id" {
  type    = string
  default = null
}

variable "discord_role_member" {
  type    = string
  default = null
}

variable "discord_role_friend" {
  type    = string
  default = null
}

variable "home_assistant_url" {
  type        = string
  default     = null
  description = "Optional Nabu Casa or Tailscale/LAN URL. The token is an ephemeral input / Key Vault secret. Set both or neither."
}

variable "write_secrets" {
  type        = bool
  default     = false
  description = "If true, write ephemeral secret inputs into Key Vault (not stored in state). Leave false in terraform.example.tfvars so CI plan cannot clobber a real vault."
}

variable "secrets_version" {
  type        = number
  default     = 1
  description = "Bump to rotate write-only Key Vault secret values. Not a secret."
}

variable "discord_token" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "DISCORD_TOKEN. Used when write_secrets is true. Gitignored tfvars or TF_VAR_discord_token. Never stored in state."
}

variable "admins_yaml" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "Contents of admins.yaml. Used when write_secrets is true and admins_yaml_file is unset."
}

variable "admins_yaml_file" {
  type        = string
  default     = null
  description = "Path to admins.yaml (gitignored). Contents are passed write-only into Key Vault; the path is not a secret."
}

variable "home_assistant_token" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "HOME_ASSISTANT_TOKEN. Required when write_secrets is true and home_assistant_url is set."
}

variable "sentry_dsn" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "SENTRY_DSN. Required when write_secrets is true and sentry_enabled is true."
}

variable "tailscale_auth_key" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "Tailscale auth key. Required when write_secrets is true and tailscale_enabled is true."
}

variable "sentry_enabled" {
  type        = bool
  default     = false
  description = "If true, the app reads sentry-dsn from Key Vault."
}

variable "tailscale_enabled" {
  type        = bool
  default     = false
  description = "Preferred HA path. Off until Thomas has a Tailscale auth key. Nabu Casa still works."
}

variable "tailscale_image" {
  type    = string
  default = "ghcr.io/tailscale/tailscale:v1.86.5"
}
