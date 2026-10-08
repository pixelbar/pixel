# 0010. Temporary GHCR CD: PRs to `dev`, `main` to prod

* Status: accepted (temporary)
* Date: 2026-10-08
* Issue: #10

## Context

Issue 10 and the architecture doc said merges to `main` publish `ghcr.io/pixelbar/pixel:<sha>` and deploy to **dev**, with prod later behind a GitHub Environment approval. CI already built the image with `push: false`.

`dev` apply (#9) is blocked: Azure Container Apps cannot pull `ghcr.io/pixelbar/pixel:main` (GHCR 401 / DENIED). The package did not exist, or was private. The image holds no secrets (`Dockerfile` copies `content/` only; `.env` and access lists are dockerignored).

Thomas asked to ship CD with a **temporary** routing change so PRs can prove a public SHA image on `dev` without waiting for prod.

## Decision

- **Pull requests** push `ghcr.io/pixelbar/pixel:<sha>` and a moving `pr-<n>` tag, then deploy that SHA to Azure Container App `pixel-dev` (resource group `pixel-dev`). Latest PR wins. Max replicas stay **1**.
- **Merges to `main`** push the SHA and a moving `main` tag, then deploy that SHA to **prod**. GitHub Environment `prod` (reviewers). Prod is **fail closed**: if `infra/envs/prod` is missing (#12), or prod ARM_* / Key Vault secrets are missing, the job fails and does not deploy. It must never copy `pixel-dev-kv` or the Mini local/Pixel Dev Discord token into prod.
- **GHCR auth:** `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`. Only the publish job has `packages: write`. The package is **public** so Container Apps can pull without a PAT in Terraform. Container Apps pin an explicit SHA, not `latest`.
- **Azure auth:** GitHub Environments `dev` / `prod`, OIDC (`ARM_CLIENT_ID` / `ARM_TENANT_ID` / `ARM_SUBSCRIPTION_ID` as variables, `id-token: write`). No Azure client secret. If `ARM_*` is unset on `dev`, that deploy **skips**. Prod still fails closed.
- **No Terraform apply** from this workflow. Image rollouts use `az containerapp update`. First create of `pixel-dev` stays #9. Stop-then-start overlap is still #11.
- Sentry releases and `just register` from CD stay later (Sentry org unknown; registration needs a Discord token we will not put in GitHub).

This **overrides** `main` → `dev` until we revert this ADR.

## Consequences

- A PR can put a SHA on `dev` once #9’s Container App exists, GHCR is public, and Environment `dev` has `ARM_*`. Until then the image still publishes.
- Merging to `main` will not start Discord on prod until #12 and prod secrets exist. The prod job is supposed to fail until then.
- Two replicas, or a Mini bot plus `pixel-dev` on the same token, still answer every command twice. CD pins min=max=1 and does not start Pixel locally.
- Revert path: point `main` at `dev` again, and put prod behind approval only.
