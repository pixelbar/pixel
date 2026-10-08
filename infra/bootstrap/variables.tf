variable "subscription_id" {
  type        = string
  description = "Azure subscription for Pixel. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "location" {
  type        = string
  description = "Azure region. West Europe is the Pixelbar default."
  default     = "westeurope"
}

variable "prefix" {
  type        = string
  description = "Name prefix. Resource groups become {prefix}-bootstrap, {prefix}-dev, {prefix}-prod."
  default     = "pixel"

  validation {
    condition     = can(regex("^[a-z0-9]{2,10}$", var.prefix))
    error_message = "prefix must be 2–10 lowercase letters or digits."
  }
}

variable "github_repository" {
  type        = string
  description = "GitHub org/repo that may federate to the GitHub identities. Other repos cannot."
  default     = "pixelbar/pixel"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be org/repo."
  }
}

# This repo was created after 2026-07-15, so GitHub OIDC subjects are immutable
# (owner and repo numeric IDs). The name-only subject never matches.
variable "github_owner_id" {
  type        = string
  description = "GitHub organization numeric ID for the OIDC subject. pixelbar is 1690472."
  default     = "1690472"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be a numeric GitHub org or user ID."
  }
}

variable "github_repository_id" {
  type        = string
  description = "GitHub repository numeric ID for the OIDC subject. pixelbar/pixel is 1402859166."
  default     = "1402859166"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be a numeric GitHub repository ID."
  }
}

variable "storage_account_name" {
  type        = string
  description = "Globally unique storage account for Terraform state (3–24 lowercase letters or digits)."
  default     = "pixelbartfstate"

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must be 3–24 lowercase letters or digits."
  }
}
