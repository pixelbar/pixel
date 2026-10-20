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
  description = "Pixel container image. On dev, first-create only: apply then ignores it (#73) and just deploy-dev / az owns the pin. On prod (#12), apply sets this image. Must not contain secrets or access files."
  default     = "ghcr.io/pixelbar/pixel:main"
}

variable "container_registry_server" {
  type        = string
  default     = null
  description = "Optional private registry host (e.g. ghcr.io). Leave null when the image is public. Org GHCR visibility cannot be changed via the API; until a maintainer makes ghcr.io/pixelbar/pixel public in the GitHub UI, Azure needs this plus Key Vault secret ghcr-pull-token."
}

variable "container_registry_username" {
  type        = string
  default     = null
  description = "Username for container_registry_server (GitHub username for GHCR). Not a secret. Required when the server is set."
}

variable "container_registry_password" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "Registry password / GHCR token. Written to Key Vault as ghcr-pull-token when write_secrets is true. Prefer a token with only read:packages. Never stored in state."
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

variable "mastodon_instance" {
  type        = string
  default     = null
  description = "Optional. MASTODON_INSTANCE origin (http or https). Not a secret. The access token is a Key Vault secret. Set both or neither."

  validation {
    condition     = var.mastodon_instance == null || can(regex("^https?://", var.mastodon_instance))
    error_message = "mastodon_instance must be an http(s) URL or unset."
  }
}

variable "spacestate_api_url" {
  type        = string
  default     = null
  description = "Optional. SPACESTATE_API_URL: the API that /spacestate calls to set the space open or closed. Not a secret. The user and token are Key Vault secrets (spacestate-user, spacestate-token). Set the URL to turn /spacestate on."

  validation {
    condition     = var.spacestate_api_url == null || can(regex("^https?://", var.spacestate_api_url))
    error_message = "spacestate_api_url must be an http(s) URL or unset."
  }
}

variable "sentry_enabled" {
  type        = bool
  default     = false
  description = "If true, the app reads SENTRY_DSN from Key Vault secret sentry-dsn."
}

variable "github_register_principal_id" {
  type        = string
  default     = null
  description = "Object (principal) ID of this env's GitHub OIDC identity (pixel-github-<env>). When set, it may read the discord-token secret and nothing else, so CD can register slash commands (ADR 0014). Null: commands are registered from a laptop."
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

  validation {
    condition     = var.secrets_version >= 1
    error_message = "secrets_version must be >= 1."
  }
}

variable "spacestate_additional_headers_enabled" {
  type        = bool
  default     = false
  description = "If true (and spacestate_api_url is set), the app reads SPACESTATE_ADDITIONAL_HEADERS from Key Vault secret spacestate-additional-headers."
}

variable "spacestate_webhook_enabled" {
  type        = bool
  default     = false
  description = "If true, turn on public HTTPS ingress to the space state webhook (port 8081, /hooks/space-state) and read SPACESTATE_WEBHOOK_SECRET from Key Vault secret spacestate-webhook-secret. Push that secret first. The health probes stay private either way."
}

variable "webhook_allowed_ip_ranges" {
  type        = list(string)
  default     = []
  description = "Optional. CIDR ranges allowed to reach the webhook ingress, such as the space state service's outbound addresses. Empty allows anyone: every request must still be signed with the webhook secret."

  validation {
    condition     = alltrue([for r in var.webhook_allowed_ip_ranges : can(cidrhost(r, 0))])
    error_message = "webhook_allowed_ip_ranges must be CIDR ranges like 203.0.113.7/32."
  }
}

variable "custom_domain" {
  type        = string
  default     = null
  description = "Optional. A hostname for the webhook ingress, such as pixel.pixelbar.nl (prod). Needs spacestate_webhook_enabled. Setting it only prints the DNS records to create (custom_domain_dns_records); bind_custom_domain binds it."

  validation {
    condition     = var.custom_domain == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.custom_domain))
    error_message = "custom_domain must be a lower-case hostname like pixel.pixelbar.nl, without a scheme or path."
  }

  validation {
    condition     = var.custom_domain == null || var.spacestate_webhook_enabled
    error_message = "custom_domain needs spacestate_webhook_enabled: without ingress there is nothing to bind it to."
  }
}

variable "bind_custom_domain" {
  type        = bool
  default     = false
  description = "Second apply of the custom domain: issue the managed certificate and bind custom_domain. Turn on only once the TXT and CNAME records from custom_domain_dns_records resolve, or the apply fails."

  validation {
    condition     = !var.bind_custom_domain || var.custom_domain != null
    error_message = "bind_custom_domain needs custom_domain."
  }
}

variable "tailscale_auth_key" {
  type        = string
  ephemeral   = true
  sensitive   = true
  default     = null
  description = "Tailscale auth key. Required when write_secrets is true and tailscale_enabled is true."
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
  description = "Log Analytics retention in days. Documented as 30 days in docs/privacy.md (Azure's floor). Changing this needs a matching notice and runbook update."

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
