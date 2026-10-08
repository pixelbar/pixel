locals {
  environments = toset(["dev", "prod"])

  tags = {
    project = "pixel"
    stack   = "bootstrap"
  }
}

resource "azurerm_resource_group" "bootstrap" {
  name     = "${var.prefix}-bootstrap"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "env" {
  for_each = local.environments

  name     = "${var.prefix}-${each.key}"
  location = var.location
  tags     = merge(local.tags, { env = each.key })
}

resource "azurerm_storage_account" "tfstate" {
  name                = var.storage_account_name
  resource_group_name = azurerm_resource_group.bootstrap.name
  location            = azurerm_resource_group.bootstrap.location

  account_tier             = "Standard"
  account_replication_type = "GRS"
  min_tls_version          = "TLS1_2"

  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  local_user_enabled              = false
  # GitHub-hosted runners need this. Do not set Disabled until CD uses a private runner.
  public_network_access = "Enabled"

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 14
    }

    container_delete_retention_policy {
      days = 14
    }
  }

  tags = local.tags
}

resource "azurerm_storage_container" "state" {
  for_each = setunion(local.environments, toset(["bootstrap"]))

  name                  = each.key
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}
