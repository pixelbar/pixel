# Write-only secret values. Terraform never stores them in state.
# Set write_secrets = true and pass the ephemeral inputs, or leave it false
# and create the same names with az / the portal.

locals {
  managed_secret_values = {
    "discord-token"        = var.discord_token
    "admins-yaml"          = var.admins_yaml
    "home-assistant-token" = var.home_assistant_token
    "sentry-dsn"           = var.sentry_dsn
    "tailscale-auth-key"   = var.tailscale_auth_key
  }
}

resource "azurerm_key_vault_secret" "managed" {
  for_each = var.write_secrets ? local.kv_secret_names : toset([])

  name         = each.key
  key_vault_id = azurerm_key_vault.this.id
  content_type = each.key == "admins-yaml" ? "text/yaml" : "text/plain"
  value_wo = (
    each.key == "admins-yaml" && var.admins_yaml_file != null ?
    file(var.admins_yaml_file) :
    local.managed_secret_values[each.key]
  )
  value_wo_version = var.secrets_version

  depends_on = [azurerm_role_assignment.kv_admin_applyer]

  lifecycle {
    precondition {
      condition = (
        each.key == "admins-yaml" ?
        (var.admins_yaml_file != null || (var.admins_yaml != null && var.admins_yaml != "")) :
        (local.managed_secret_values[each.key] != null && local.managed_secret_values[each.key] != "")
      )
      error_message = "write_secrets = true requires an input for Key Vault secret ${each.key} (write-only, not stored in state). Set it in terraform.tfvars (gitignored) or TF_VAR_*."
    }
  }
}
