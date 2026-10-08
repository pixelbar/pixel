output "resource_group_name" {
  value = module.pixel.resource_group_name
}

output "container_app_name" {
  value = module.pixel.container_app_name
}

output "key_vault_name" {
  value = module.pixel.key_vault_name
}

output "key_vault_secret_names" {
  value       = module.pixel.key_vault_secret_names
  description = "Secrets the Container App reads. write_secrets writes them from ephemeral inputs; otherwise create each name before the app can start."
}

output "data_storage_account_name" {
  value = module.pixel.data_storage_account_name
}

output "data_share_name" {
  value = module.pixel.data_share_name
}

output "log_analytics_workspace_name" {
  value = module.pixel.log_analytics_workspace_name
}

output "tailscale_enabled" {
  value = module.pixel.tailscale_enabled
}
