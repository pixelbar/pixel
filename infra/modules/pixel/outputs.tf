output "resource_group_name" {
  value = data.azurerm_resource_group.this.name
}

output "container_app_name" {
  value       = azurerm_container_app.this.name
  description = "Container App name. One replica, no public ingress."
}

output "container_app_environment_name" {
  value = azurerm_container_app_environment.this.name
}

output "key_vault_name" {
  value       = azurerm_key_vault.this.name
  description = "Secret values are write-only Terraform inputs (write_secrets) or az / the portal. Never stored in state."
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "key_vault_secret_names" {
  value       = sort(tolist(local.kv_secret_names))
  description = "Secrets the Container App reads. write_secrets writes them from ephemeral inputs; otherwise create each name before the app can start."
}

output "data_storage_account_name" {
  value = azurerm_storage_account.data.name
}

output "data_share_name" {
  value       = azurerm_storage_share.data.name
  description = "Azure Files share mounted at /app/persist (members.yaml, home-assistant/, data/)."
}

output "log_analytics_workspace_name" {
  value = azurerm_log_analytics_workspace.this.name
}

output "managed_identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "tailscale_enabled" {
  value = var.tailscale_enabled
}
