resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name_prefix}-app"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = local.location
  tags                = local.tags
}

# Key Vault Administrator so this apply can write secrets (write-only inputs or az).
resource "azurerm_role_assignment" "kv_admin_applyer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "kv_secrets_app" {
  scope                            = azurerm_key_vault.this.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
}

# So the applyer can seed members.yaml and devices.yaml onto the share.
resource "azurerm_role_assignment" "files_applyer" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Storage File Data Privileged Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
