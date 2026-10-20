output "resource_group_name" {
  value = data.azurerm_resource_group.this.name
}

output "container_app_name" {
  value       = local.name_prefix
  description = "Container App name (local.name_prefix). One replica. Public ingress only when spacestate_webhook_enabled. Not taken from the app resource object — that object is sensitive because of secret blocks."
}

output "container_app_environment_name" {
  value = azurerm_container_app_environment.this.name
}

output "key_vault_name" {
  value       = azurerm_key_vault.this.name
  description = "App secret values come from just secrets-push; infra ones from write-only Terraform inputs (write_secrets) or az. Never stored in state."
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "key_vault_secret_names" {
  value       = sort(tolist(local.kv_secret_names))
  description = "Secrets the Container App reads. Push the app ones with just secrets-push; write_secrets writes only tailscale-auth-key and ghcr-pull-token. Each must exist before the app can start."
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

output "spacestate_webhook_url" {
  # Built from the environment's domain, like container_app_name, rather than read from
  # the sensitive app object. External ingress is always <app>.<environment domain>.
  value       = var.spacestate_webhook_enabled ? "https://${local.name_prefix}.${azurerm_container_app_environment.this.default_domain}/hooks/space-state" : null
  description = "Where the space state service sends its webhook, or null when it is off. Give it this URL and the spacestate-webhook-secret value."
}
