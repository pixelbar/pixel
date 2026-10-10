resource "azurerm_log_analytics_workspace" "this" {
  name                = "${local.name_prefix}-logs"
  location            = local.location
  resource_group_name = data.azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${local.name_prefix}-cae"
  location                   = local.location
  resource_group_name        = data.azurerm_resource_group.this.name
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

resource "azurerm_container_app_environment_storage" "persist" {
  name                         = "pixel-persist"
  container_app_environment_id = azurerm_container_app_environment.this.id
  account_name                 = azurerm_storage_account.data.name
  share_name                   = azurerm_storage_share.data.name
  access_key                   = azurerm_storage_account.data.primary_access_key
  access_mode                  = "ReadWrite"
}

resource "azurerm_container_app" "this" {
  name                         = local.name_prefix
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = data.azurerm_resource_group.this.name
  revision_mode                = "Single"
  max_inactive_revisions       = 3

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  dynamic "secret" {
    for_each = local.key_vault_secret_ids
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  dynamic "registry" {
    for_each = var.container_registry_server != null ? [1] : []
    content {
      server               = var.container_registry_server
      username             = var.container_registry_username
      password_secret_name = "ghcr-pull-token"
    }
  }

  template {
    # Discord connects a long-lived gateway. Two replicas answer every command
    # twice. min=max=1 is a hard constraint, not a default. Overlap during a
    # revision swap is #11 (stop-then-start). Do not add a database lock.
    min_replicas                     = 1
    max_replicas                     = 1
    termination_grace_period_seconds = 30

    volume {
      name          = "persist"
      storage_name  = azurerm_container_app_environment_storage.persist.name
      storage_type  = "AzureFile"
      mount_options = local.azure_file_mount_options
    }

    volume {
      name         = "secrets"
      storage_type = "Secret"
    }

    init_container {
      name   = "prepare-volume"
      image  = "busybox:1.37.0"
      cpu    = 0.25
      memory = "0.5Gi"
      command = [
        "/bin/sh",
        "-c",
        "mkdir -p ${local.persist_mount}/data/logs ${local.persist_mount}/home-assistant && chmod -R a+rwX ${local.persist_mount}",
      ]

      volume_mounts {
        name = "persist"
        path = local.persist_mount
      }
    }

    container {
      name   = "pixel"
      image  = var.container_image
      cpu    = 0.5
      memory = "1Gi"

      liveness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        initial_delay           = 10
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 3
      }

      # Discord may take a while to connect. Failed readiness does not restart
      # the replica (liveness does). /readyz is 503 until the gateway is up.
      readiness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/readyz"
        initial_delay           = 15
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 12
        success_count_threshold = 1
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 24
      }

      dynamic "env" {
        for_each = local.pixel_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.pixel_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      volume_mounts {
        name = "persist"
        path = local.persist_mount
      }

      volume_mounts {
        name = "secrets"
        path = local.secrets_mount
      }
    }

    # Userspace Tailscale: no TUN on Container Apps. SOCKS5 on localhost is the
    # only way Pixel's netns reaches the mesh. Do not probe this container —
    # an unhealthy sidecar restarts the whole replica and drops Discord.
    dynamic "container" {
      for_each = var.tailscale_enabled ? [1] : []
      content {
        name   = "tailscale"
        image  = var.tailscale_image
        cpu    = 0.25
        memory = "0.5Gi"

        env {
          name        = "TS_AUTHKEY"
          secret_name = "tailscale-auth-key"
        }

        env {
          name  = "TS_HOSTNAME"
          value = local.name_prefix
        }

        env {
          name  = "TS_USERSPACE"
          value = "true"
        }

        env {
          name  = "TS_SOCKS5_SERVER"
          value = "127.0.0.1:1055"
        }

        env {
          name  = "TS_ACCEPT_DNS"
          value = "false"
        }

        env {
          name  = "TS_EXTRA_ARGS"
          value = local.tailscale_advertise_tags
        }

        env {
          name  = "TS_ENABLE_HEALTH_CHECK"
          value = "true"
        }

        env {
          name  = "TS_LOCAL_ADDR_PORT"
          value = "127.0.0.1:9002"
        }

        # containerboot treats ACA as Kubernetes (injected KUBERNETES_SERVICE_HOST)
        # and dies looking for a service account. Empty these. #74 / tailscale#18558.
        env {
          name  = "KUBERNETES_SERVICE_HOST"
          value = ""
        }

        env {
          name  = "TS_KUBE_SECRET"
          value = ""
        }
      }
    }

    # Pixel cannot connect() to 100.x / MagicDNS in userspace. socat listens on
    # 127.0.0.1:8123 and SOCKS5s to HA. HOME_ASSISTANT_URL is that localhost.
    # ACA consumption floor is 0.25 vCPU / 0.5Gi.
    dynamic "container" {
      for_each = var.tailscale_enabled ? [1] : []
      content {
        name   = "ha-proxy"
        image  = var.ha_proxy_image
        cpu    = 0.25
        memory = "0.5Gi"
        command = [
          "socat",
          "TCP-LISTEN:8123,bind=127.0.0.1,reuseaddr,fork",
          "SOCKS5:127.0.0.1:${var.home_assistant_mesh_host}:8123,socksport=1055",
        ]
      }
    }
  }

  tags = local.tags

  lifecycle {
    precondition {
      condition     = var.container_registry_server == null || (var.container_registry_username != null && var.container_registry_username != "")
      error_message = "container_registry_username is required when container_registry_server is set."
    }
    precondition {
      condition     = !var.tailscale_enabled || (var.home_assistant_mesh_host != null && var.home_assistant_mesh_host != "")
      error_message = "tailscale_enabled requires home_assistant_mesh_host (HA MagicDNS name, no scheme)."
    }
    precondition {
      condition     = var.tailscale_enabled || var.home_assistant_mesh_host == null
      error_message = "home_assistant_mesh_host is only used when tailscale_enabled is true."
    }
    precondition {
      condition     = !var.tailscale_enabled || var.home_assistant_url == null
      error_message = "When tailscale_enabled, do not set home_assistant_url. Pixel uses http://127.0.0.1:8123; set home_assistant_mesh_host. No Nabu Casa fallback."
    }
  }

  depends_on = [
    azurerm_role_assignment.kv_secrets_app,
    azurerm_container_app_environment_storage.persist,
    azurerm_key_vault_secret.managed,
  ]
}
