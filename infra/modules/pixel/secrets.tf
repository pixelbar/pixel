# Write-only secret values for the manifest's infra group (tailscale-auth-key,
# ghcr-pull-token). Terraform never stores them in state. Set write_secrets = true
# and pass the ephemeral inputs, or leave it false and create the same names with
# az / the portal.
#
# The app group (discord-token, admins-yaml, ...) is written only by
# just secrets-push / just push (ADR 0016, ADR 0017). Terraform references those
# secrets from the Container App but never writes them.

locals {
  managed_secret_values = {
    "tailscale-auth-key" = var.tailscale_auth_key
    "ghcr-pull-token"    = var.container_registry_password
  }
}

resource "azurerm_key_vault_secret" "infra" {
  for_each = var.write_secrets ? local.kv_infra_secret_names : toset([])

  name             = each.key
  key_vault_id     = azurerm_key_vault.this.id
  content_type     = "text/plain"
  value_wo         = local.managed_secret_values[each.key]
  value_wo_version = var.secrets_version

  depends_on = [azurerm_role_assignment.kv_admin_applyer]

  lifecycle {
    precondition {
      condition     = local.managed_secret_values[each.key] != null && local.managed_secret_values[each.key] != ""
      error_message = "write_secrets = true requires an input for Key Vault secret ${each.key} (write-only, not stored in state). Set it in gitignored secrets.auto.tfvars or TF_VAR_*."
    }
  }
}

# Until ADR 0017, one resource wrote every secret. The infra ones keep their state
# under the new name, so nothing is rewritten.
moved {
  from = azurerm_key_vault_secret.managed["tailscale-auth-key"]
  to   = azurerm_key_vault_secret.infra["tailscale-auth-key"]
}

moved {
  from = azurerm_key_vault_secret.managed["ghcr-pull-token"]
  to   = azurerm_key_vault_secret.infra["ghcr-pull-token"]
}

# Whatever is left under the old name is an app secret. Terraform forgets it and
# leaves it in Key Vault, where just secrets-push owns it. Plan shows "will no
# longer be managed by Terraform, but will not be destroyed". Keep this block
# until every stack has applied it.
removed {
  from = azurerm_key_vault_secret.managed

  lifecycle {
    destroy = false
  }
}
