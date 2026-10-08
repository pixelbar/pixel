resource "azurerm_recovery_services_vault" "this" {
  name                = "${local.name_prefix}-rsv"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.this.name
  sku                 = "Standard"
  storage_mode_type   = "LocallyRedundant"

  tags = local.tags
}

resource "azurerm_backup_policy_file_share" "daily" {
  name                = "${local.name_prefix}-files-daily"
  resource_group_name = data.azurerm_resource_group.this.name
  recovery_vault_name = azurerm_recovery_services_vault.this.name
  timezone            = "W. Europe Standard Time"

  backup {
    frequency = "Daily"
    time      = "03:00"
  }

  retention_daily {
    count = 14
  }
}

resource "azurerm_backup_container_storage_account" "data" {
  resource_group_name = data.azurerm_resource_group.this.name
  recovery_vault_name = azurerm_recovery_services_vault.this.name
  storage_account_id  = azurerm_storage_account.data.id
}

resource "azurerm_backup_protected_file_share" "data" {
  resource_group_name       = data.azurerm_resource_group.this.name
  recovery_vault_name       = azurerm_recovery_services_vault.this.name
  source_storage_account_id = azurerm_backup_container_storage_account.data.storage_account_id
  source_file_share_name    = azurerm_storage_share.data.name
  backup_policy_id          = azurerm_backup_policy_file_share.daily.id

  depends_on = [azurerm_backup_container_storage_account.data]
}
