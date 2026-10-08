# 0010. Temporary GHCR CD: local `dev`, `main` to prod

* Status: accepted (temporary)
* Date: 2026-10-08
* Issue: #10

## Context

Issue 10 and the architecture doc said merges to `main` publish `ghcr.io/pixelbar/pixel:<sha>` and deploy to **dev**, with prod later behind a GitHub Environment approval. CI already built the image with `push: false`.

`dev` apply (#9) is blocked: Azure Container Apps cannot pull `ghcr.io/pixelbar/pixel:main` (GHCR 401 / DENIED). The image holds no secrets (`Dockerfile` copies `content/` only; `.env` and access lists are dockerignored).

A first pass had pull requests deploy to Azure `dev`. That fights local testing: one replica, and CI’s merge SHA is not the working tree you are iterating on. Thomas asked for **local builds on `dev`** and **prod = latest `main`**.

## Decision

- **Azure `dev`:** `just deploy-dev` on a laptop (the Mini). It builds this tree, pushes `ghcr.io/pixelbar/pixel:<sha>` (or a `dev-dirty-*` tag if the tree is dirty) plus moving `:dev`, and runs `az containerapp update` on `pixel-dev` only. Max replicas stay **1**. It never deploys prod and does not start Pixel locally. CI does **not** roll PRs onto `dev`.
- **Merges to `main`:** [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml) pushes the SHA and moving tag `main`, then deploys that SHA to **prod**. GitHub Environment `prod` (reviewers). Prod is **fail closed**: if `infra/envs/prod` is missing (#12), or prod ARM_* / Key Vault secrets are missing, the job fails and does not deploy. It must never copy `pixel-dev-kv` or the Mini local/Pixel Dev Discord token into prod.
- **GHCR auth (CI):** `docker/login-action` with `GITHUB_TOKEN`. Only the publish job has `packages: write`. **Local:** `just docker-login-ghcr` uses `gh auth token` (needs `write:packages`). The package is **public** so Container Apps can pull without a PAT in Terraform. The running app pins an explicit SHA (or dirty tag), not `latest`.
- **Azure auth:** local `az` for `dev`. Prod uses GitHub Environment `prod` OIDC (`ARM_*` variables, `id-token: write`). No Azure client secret. Prod still fails closed if `ARM_*` is unset.
- **No Terraform apply** from CD or `just deploy-dev`. First create of `pixel-dev` stays #9. Stop-then-start overlap is still #11.
- Sentry releases and `just register` from CD stay later.

This **overrides** `main` → `dev` until we revert this ADR.

## Consequences

- You can put a local (even dirty) tree on `dev` without waiting for another CI head. Do not also run `just dev` on the same Pixel Dev token while `pixel-dev` is up.
- Merging to `main` will not start Discord on prod until #12 and prod secrets exist. The prod job is supposed to fail until then.
- Two replicas still answer every command twice. Both paths pin min=max=1.
- Revert path: point `main` at `dev` again, and put prod behind approval only.
