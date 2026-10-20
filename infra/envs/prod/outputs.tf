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
  description = "Secrets the Container App reads. Push the app ones with just secrets-push; write_secrets writes only tailscale-auth-key and ghcr-pull-token. Each must exist before the app can start."
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

output "spacestate_webhook_url" {
  value       = module.pixel.spacestate_webhook_url
  description = "Where the space state service sends its webhook, or null when it is off."
}
