# 0004. Azure Container Apps, single replica, GHCR, two environments

* Status: accepted ("no public ingress" amended by [0018](0018-space-state-webhook.md): optional ingress for the space state webhook only)
* Date: 2026-10-03

## Context

A Discord gateway bot needs an always-on process. Two processes on the same bot token both connect and answer every command twice. Pixel is a small community bot: one container per environment is enough. Horizontal scaling is a non-goal.

How that is built is later ADRs. This record is the hosting shape.

## Decision

- **Azure Container Apps**, exactly **one replica** (`min_replicas = max_replicas = 1`), no public ingress, with a managed identity. Replica count is not a variable.
- **Images** on GitHub Container Registry: `ghcr.io/pixelbar/pixel:<sha>`. The image contains no secrets and no access lists.
- **Two environments:** `dev` (Pixel Dev bot, test guild) and `prod` (Pixel bot, Pixelbar guild). Separate bots, tokens and vaults. Never copy the Mini / Pixel Dev token into prod.
- **Secrets** in Key Vault, not in the image or Terraform state. Writable state (`members.yaml`, schedules, Home Assistant files) on Azure Files.
- Implementation: [ADR 0008](0008-terraform-bootstrap.md) (bootstrap and OIDC), [ADR 0009](0009-container-apps-dev.md) (`dev`), [ADR 0010](0010-ghcr-cd.md) (how images move), [ADR 0012](0012-prod-environment.md) (`prod` and approved CD).

## Consequences

- Two replicas would still double-answer. Deploys must not overlap (#11).
- Local `just dev` and the hosted app must not share a bot token.
- Changing replica count is a module edit. A database is not required to enforce "one instance".
