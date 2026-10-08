provider "azurerm" {
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.App",
    "Microsoft.OperationalInsights",
    "Microsoft.KeyVault",
    "Microsoft.Storage",
    "Microsoft.ManagedIdentity",
    "Microsoft.RecoveryServices",
  ]

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }

    key_vault {
      # Dev must be tear-downable. Prod (#12) should leave purge protection on
      # and not purge on destroy.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}
