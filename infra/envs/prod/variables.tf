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
  default     = "pixel-prod-kv"

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]{3,24}$", var.key_vault_name))
    error_message = "key_vault_name must be 3–24 letters, digits or hyphens."
  }
}

variable "data_storage_account_name" {
  type        = string
  description = "Globally unique storage account for the Azure Files volume. Not the Terraform state account."
  default     = "pixelproddata"

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.data_storage_account_name))
    error_message = "data_storage_account_name must be 3–24 lowercase letters or digits."
  }
}

variable "container_image" {
  type        = string
  description = "Image this apply pins on pixel-prod (azurerm_container_app.managed). Prefer a GHCR SHA already published from main, not a rebuild. CD later rolls the same digest with az."
  default     = "ghcr.io/pixelbar/pixel:main"
}

variable "container_registry_server" {
  type        = string
  default     = null
  description = "Optional private registry host (e.g. ghcr.io). Leave null when the image is public."
}

variable "container_registry_username" {
  type        = string
  default     = null
  description = "Username for container_registry_server. Not a secret. Required when the server is set."
}

variable "container_registry_password" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "Registry password / GHCR token. Used when write_secrets is true. Gitignored tfvars or TF_VAR_container_registry_password. Never stored in state."
}

variable "discord_app_id" {
  type        = string
  description = "Production Pixel application ID (a separate Discord app from Pixel Dev). Not a secret. Real value in terraform.tfvars (gitignored)."
}

variable "discord_guild_id" {
  type        = string
  description = "Production guild ID. Not a secret. Real value in terraform.tfvars (gitignored). Never the Pixel Dev test guild."
}

variable "discord_announcements_channel_id" {
  type    = string
  default = null
}

variable "discord_announce_bot_channel_id" {
  type    = string
  default = null
}

variable "discord_closing_time_channel_id" {
  type    = string
  default = null
}

variable "discord_parking_channel_id" {
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

variable "discord_role_sync" {
  type    = string
  default = null
}

variable "home_assistant_url" {
  type        = string
  default     = null
  description = "Optional Nabu Casa or Tailscale/LAN URL. The token is an ephemeral input / Key Vault secret. Set both or neither."
}

variable "mastodon_instance" {
  type        = string
  default     = null
  description = "Optional Mastodon instance origin. The access token is an ephemeral input / Key Vault secret. Set both or neither."
}

variable "spacestate_api_url" {
  type        = string
  default     = null
  description = "Optional. The API /spacestate calls to set the space open or closed. Not a secret. The user and token are ephemeral inputs / Key Vault secrets. Set the URL to turn /spacestate on."
}

variable "openr_building_id" {
  type        = string
  default     = null
  description = "Optional. The OpenR building whose doors Pixel opens. Not a secret. The account is Key Vault secrets openr-email and openr-password. Set it to turn OpenR on."
}

variable "openr_doors" {
  type        = string
  default     = null
  description = "Optional. The doors /openr open offers, as Name=ID pairs separated by commas. Never the parking gate."
}

variable "openr_gate_door" {
  type        = string
  default     = null
  description = "Optional. The OpenR ID of the parking gate, which only /park opens."
}

variable "write_secrets" {
  type        = bool
  default     = false
  description = "If true, write the infra-group secrets (tailscale-auth-key, ghcr-pull-token) into Key Vault from ephemeral inputs (not stored in state). Never the app group: just secrets-push owns those (ADR 0017). Leave false in the example tfvars so a CI plan cannot clobber a real vault."
}

variable "secrets_version" {
  type        = number
  default     = 1
  description = "Bump to rotate write-only Key Vault secret values. Not a secret."
}

variable "spacestate_additional_headers_enabled" {
  type        = bool
  default     = false
  description = "If true (and spacestate_api_url is set), the app reads the extra headers from Key Vault secret spacestate-additional-headers."
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

variable "github_register_principal_id" {
  type        = string
  default     = null
  description = "Principal ID of pixel-github-prod (az identity show -g pixel-bootstrap -n pixel-github-prod --query principalId). Lets the Release workflow read discord-token, and only that, to register slash commands (ADR 0014)."
}
