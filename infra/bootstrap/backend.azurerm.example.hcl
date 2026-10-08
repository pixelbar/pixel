# After the first (local) apply, copy this to backend.azurerm.hcl (gitignored
# if you customise it; the example is enough if the defaults applied) and follow
# README.md to migrate state.

resource_group_name  = "pixel-bootstrap"
storage_account_name = "pixelbartfstate"
container_name       = "bootstrap"
key                  = "terraform.tfstate"
use_azuread_auth     = true
subscription_id      = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
