resource "azurerm_user_assigned_identity" "github" {
  for_each = local.environments

  name                = "${var.prefix}-github-${each.key}"
  resource_group_name = azurerm_resource_group.bootstrap.name
  location            = azurerm_resource_group.bootstrap.location
  tags                = merge(local.tags, { env = each.key })
}

resource "azurerm_federated_identity_credential" "github" {
  for_each = local.environments

  name                      = "github-environment-${each.key}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github[each.key].id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = "repo:${var.github_repository}:environment:${each.key}"
}

# The identity that applies this stack must be able to read and write blobs
# after shared keys are off (Owner on the subscription is not enough on the data plane).
resource "azurerm_role_assignment" "state_applyer" {
  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "github_state" {
  for_each = local.environments

  scope                = "${azurerm_storage_account.tfstate.id}/blobServices/default/containers/${each.key}"
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
  # The identity exists before Entra has replicated it.
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_storage_container.state]
}

resource "azurerm_role_assignment" "github_env" {
  for_each = local.environments

  scope                            = azurerm_resource_group.env[each.key].id
  role_definition_name             = "Contributor"
  principal_id                     = azurerm_user_assigned_identity.github[each.key].principal_id
  skip_service_principal_aad_check = true
}
