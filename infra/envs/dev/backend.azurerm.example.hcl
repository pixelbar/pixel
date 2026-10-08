# Remote state for the dev environment stack. Bootstrap already created the
# container. Copy to backend.azurerm.hcl only if you customise it.

resource_group_name  = "pixel-bootstrap"
storage_account_name = "pixelbartfstate"
container_name       = "dev"
key                  = "terraform.tfstate"
use_azuread_auth     = true
subscription_id      = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
