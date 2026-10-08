# 0010. Temporary GHCR CD: local `dev`, `main` publishes only

* Status: accepted (temporary)
* Date: 2026-10-08
* Issue: #10

## Context

Issue 10 and the architecture doc said merges to `main` publish `ghcr.io/pixelbar/pixel:<sha>` and deploy to **dev**, with prod later behind a GitHub Environment approval. CI already built the image with `push: false`.

`dev` apply (#9) is blocked: Azure Container Apps cannot pull `ghcr.io/pixelbar/pixel:main` (GHCR 401 / DENIED). The image holds no secrets (`Dockerfile` copies `content/` only; `.env` and access lists are dockerignored).

A first pass had pull requests deploy to Azure `dev`. That fights local testing: one replica, and CI’s merge SHA is not the working tree you are iterating on. Thomas asked for **local builds on `dev`** and **prod = latest `main`**. Prod is not ready (#12, prod secrets), so auto-deploying `main` to prod was gated off: the workflow must not log in to Azure or touch `pixel-prod`.

## Decision

- **Azure `dev`:** `just deploy-dev` on a laptop (the Mini). It builds this tree, pushes `ghcr.io/pixelbar/pixel:<sha>` (or a `dev-dirty-*` tag if the tree is dirty) plus moving `:dev`, and runs `az containerapp update` on `pixel-dev` only. Max replicas stay **1**. It never deploys prod and does not start Pixel locally. After the app rolls, it runs `just register` against the Pixel Dev guild from local `.env`, then a Sentry release (local recipe still skips if org/token are unset; a Sentry failure still fails the recipe). CI does **not** roll PRs onto `dev`.
- **Merges to `main`:** [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml) pushes the SHA and moving tag `main`, then creates a Sentry release with source maps when org/token are set. **Prod CD is off** until #12: the workflow does not use GitHub Environment `prod`, does not Azure-login, and has no path to `pixel-prod`. Fail closed — do not copy `pixel-dev-kv` or the Mini local/Pixel Dev Discord token into prod.
- **GHCR auth (CI):** `docker/login-action` with `GITHUB_TOKEN`. Only the publish job has `packages: write`. **Local:** `just docker-login-ghcr` uses `gh auth token` (needs `write:packages`). The package is **public** so Container Apps can pull without a PAT in Terraform. The running app pins an explicit SHA (or dirty tag), not `latest`.
- **Azure auth:** local `az` for `dev`. Prod OIDC (`ARM_*` on GitHub Environment `prod`) stays unused until prod CD is turned back on with #12.
- **No Terraform apply** from CD or `just deploy-dev`. First create of `pixel-dev` stays #9. Stop-then-start overlap is still #11.
- **Sentry:** release name is `PIXEL_VERSION` (the image SHA). Source maps upload from `dist/` with URL prefix `/app/dist`. The CD job **fails closed** if `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, or `SENTRY_PROJECT` is missing.
- **`just register`:** part of `just deploy-dev` only (Pixel Dev `.env`). Not from `main` CD (that would need the prod Discord token, which must not be the Mini/dev token).

This **overrides** `main` → `dev` and the short-lived `main` → prod deploy until we revert this ADR.

## Consequences

- You can put a local (even dirty) tree on `dev` without waiting for another CI head. Do not also run `just dev` on the same Pixel Dev token while `pixel-dev` is up.
- Merging to `main` publishes an image and does **not** start Discord on prod. Prod stays dark until #12.
- Two replicas still answer every command twice. Both paths pin min=max=1.
- Revert path: point `main` at `dev` again, or restore prod deploy behind Environment `prod` approval once #12 exists.
