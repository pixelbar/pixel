resource "azurerm_key_vault" "this" {
  name                          = var.key_vault_name
  location                      = local.location
  resource_group_name           = data.azurerm_resource_group.this.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.purge_protection_enabled
  soft_delete_retention_days    = 7
  public_network_access_enabled = true

  # Container Apps reads secrets over the platform network. Do not put secret
  # *values* in Terraform; this vault only exists so values can be set later.
  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  tags = local.tags
}
