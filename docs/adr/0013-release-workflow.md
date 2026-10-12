# 0013. Releases cut versions and promote prod

* Status: accepted
* Date: 2026-10-12

## Context

ADR 0012 promoted every merge to `main` onto `pixel-prod` after GitHub Environment `prod` approval. The Release workflow also ran on those pushes and cut `CHANGELOG.md` Unreleased into a version. Because that bump commit uses `GITHUB_TOKEN`, it does not start CD, so prod often ran the **pre-bump** SHA.

Thomas asked to stop deploying prod on every merge. Unreleased notes should accumulate on `main` until a human cuts a release. The VitePress site in `docs/` should ship as that same release, not on every docs change to `main`.

## Decision

- **Merges to `main`:** [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml) still publishes `ghcr.io/pixelbar/pixel:<sha>` and `:main`, and uploads Sentry source maps. It does **not** log in to Azure, does not use GitHub Environment `prod`, and has no path to `pixel-prod`. It does not publish the docs site.
- **A human cuts a release:** [`.github/workflows/release.yml`](../../.github/workflows/release.yml) (`workflow_dispatch` on `main`). It runs `just bump --commit` (Added → minor, Fixed/Changed → patch, never major before 1.0), pushes the `Release vX.Y.Z` commit and tag, opens a GitHub Release with those notes, **rebuilds** GHCR from that commit (`:<sha>`, `:vX.Y.Z`, `:main`), uploads Sentry maps for Sentry environment `prod`, publishes the VitePress site to GitHub Pages, then the `prod-cd` job (GitHub Environment `prod`) rolls `pixel-prod` to **that same digest** with `az containerapp update`. It does not apply Terraform. Approvers stay on Environment `prod` (required reviewers, branch `main`).
- **Azure `dev`:** still `just deploy-dev`. CI still does not deploy pull requests.
- **Docs PRs:** [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) still builds the site on pull requests that touch `docs/`. Publishing from `main` is the Release workflow. `workflow_dispatch` on Docs site remains an escape hatch to republish without a version bump.
- **Never copy** `pixel-dev-kv`, the Mini `.env`, or the Pixel Dev bot token into prod.

This **supersedes** ADR 0012's promotion-on-merge clause. `infra/envs/prod`, Environment `prod` OIDC, and "no Terraform apply from CD" stay as 0012 decided.

## Consequences

- Unreleased changelog entries sit on `main` until someone runs **Actions → Release → Run workflow** on `main`.
- The image prod runs includes the bumped `package.json` version (`/ping`), not the merge SHA from before the bump.
- If Azure or Pages fails after the tag exists, use **Re-run failed jobs**. Re-running every job also works: HEAD is already `Release vX.Y.Z` and Unreleased is empty, so the bump job continues that version instead of failing.
- After a command-changing release, `just register` still needs a **prod** `.env` on a laptop. The GitHub identity is Contributor on the RG, not Key Vault Secrets User.
