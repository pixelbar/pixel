output "subscription_id" {
  value       = var.subscription_id
  description = "Azure subscription. Put this in the GitHub environment as ARM_SUBSCRIPTION_ID (a variable, not a secret)."
}

output "tenant_id" {
  value       = data.azurerm_client_config.current.tenant_id
  description = "Entra tenant. Put this in the GitHub environment as ARM_TENANT_ID."
}

output "location" {
  value = var.location
}

output "bootstrap_resource_group" {
  value = azurerm_resource_group.bootstrap.name
}

output "environment_resource_groups" {
  value = { for name, rg in azurerm_resource_group.env : name => rg.name }
}

output "storage_account_name" {
  value = azurerm_storage_account.tfstate.name
}

output "state_containers" {
  value = { for name, c in azurerm_storage_container.state : name => c.name }
}

output "github_client_ids" {
  value       = { for name, id in azurerm_user_assigned_identity.github : name => id.client_id }
  description = "Per-environment client IDs. Put each in that GitHub environment as ARM_CLIENT_ID."
}
