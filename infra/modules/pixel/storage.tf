# Writable volume for members.yaml, Home Assistant files, and /app/data.
# Azure Container Apps can only mount Azure Files over SMB with the account
# key (identity-based mounts are not supported yet). That key is a platform
# credential and will appear in Terraform state. Pixel tokens and YAML do not.
# See docs/adr/0009-container-apps-dev.md.
resource "azurerm_storage_account" "data" {
  name                = var.data_storage_account_name
  resource_group_name = data.azurerm_resource_group.this.name
  location            = local.location

  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"
  min_tls_version          = "TLS1_2"

  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  local_user_enabled              = false
  public_network_access           = "Enabled"

  share_properties {
    retention_policy {
      days = 14
    }
  }

  tags = local.tags
}

resource "azurerm_storage_share" "data" {
  name               = "pixel"
  storage_account_id = azurerm_storage_account.data.id
  quota              = 5
  enabled_protocol   = "SMB"
  access_tier        = "Hot"
}
