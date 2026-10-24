# A custom hostname for the webhook ingress (pixel.pixelbar.nl for prod), with an
# Azure-managed certificate. pixelbar.nl's DNS is at TransIP, outside Azure, so it takes
# two applies (ADR 0018):
#   1. custom_domain set, bind_custom_domain = false: read custom_domain_dns_records and
#      create the TXT and CNAME records at TransIP.
#   2. Once they resolve, bind_custom_domain = true: Azure issues the certificate (CNAME
#      validation, the same record the binding needs) and binds the hostname.
# The default *.azurecontainerapps.io address keeps working throughout.

locals {
  # Whichever of the two app resources this stack has (dev ignores the image, prod doesn't).
  container_app_id = var.environment == "dev" ? azurerm_container_app.this[0].id : azurerm_container_app.managed[0].id

  # The app's own address: the CNAME target, and the webhook URL until the domain is bound.
  default_fqdn = "${local.name_prefix}.${azurerm_container_app_environment.this.default_domain}"
}

resource "azurerm_container_app_environment_managed_certificate" "custom_domain" {
  count = var.bind_custom_domain ? 1 : 0

  name                         = replace(var.custom_domain, ".", "-")
  container_app_environment_id = azurerm_container_app_environment.this.id
  subject_name                 = var.custom_domain
  domain_control_validation    = "CNAME"
  tags                         = local.tags
}

resource "azurerm_container_app_custom_domain" "this" {
  count = var.bind_custom_domain ? 1 : 0

  name                                     = var.custom_domain
  container_app_id                         = local.container_app_id
  container_app_environment_certificate_id = azurerm_container_app_environment_managed_certificate.custom_domain[0].id
  certificate_binding_type                 = "SniEnabled"

  # The certificate reference already orders these, but issuance has been seen to race
  # the binding (pixelbar/spacestate hit it), so say it explicitly.
  depends_on = [azurerm_container_app_environment_managed_certificate.custom_domain]
}
