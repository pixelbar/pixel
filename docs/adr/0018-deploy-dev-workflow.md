# 0018. A workflow deploys a branch or pull request to dev

* Status: accepted
* Date: 2026-10-24

## Context

ADR 0010 made `just deploy dev` on a laptop the only way onto Azure `dev`, after a first pass that rolled every pull request onto it fought local testing: there is one replica, and each push replaced what someone was testing. Since then, putting a branch on the Pixel Dev bot has needed a laptop with Docker, `gh` with `write:packages`, `az` on the subscription and a `.env.dev`, which shuts out reviewers and anyone away from the Mini. Bootstrap already gives GitHub Environment `dev` an OIDC identity (`pixel-github-dev`) with Contributor on `pixel-dev`, unused for CD.

## Decision

- **A `Deploy dev` workflow** ([`.github/workflows/deploy-dev.yml`](../../.github/workflows/deploy-dev.yml)), `workflow_dispatch` only, takes a pull request number, branch or SHA (empty: the branch it was run from). `just deploy-remote dev <ref>` starts it from `main`'s definition. Pushes and pull requests never start it, so ADR 0010's reason for not deploying PRs still holds: nothing replaces the dev bot unless a person asks.
- It does what a Release does, for dev and without a version: `just check` on that commit, GHCR `:<sha>` and `:dev` (never `:main` or `:vX.Y.Z`), the no-secrets image check, `az containerapp update` on `pixel-dev` with min=max=1 in Environment `dev` (refusing unless the app has `PIXEL_ENV=dev`), dev slash commands, and a Sentry release in environment `dev`. No changelog cut, tag or GitHub Release. No Terraform apply.
- **Only this repository's branches.** A pull request from a fork is refused: its code would run with the Pixel Dev token. A maintainer who has read it can push it here first.
- **Registration as ADR 0014,** with the dev identity: `github_register_principal_id` in `infra/envs/dev` gives `pixel-github-dev` Key Vault Secrets User on `discord-token` only, and the job reads the app ID, guild and token reference from the running `pixel-dev`.
- Runs share one concurrency group and queue, never cancel.
- `just deploy dev` stays, for a working tree that isn't pushed.

This **supersedes** the "CI does not roll PRs onto `dev`" clause of ADR 0010. Everything else in it stands.

## Consequences

- A maintainer applies `infra/envs/dev` once with `github_register_principal_id` set (`az identity show -g pixel-bootstrap -n pixel-github-dev --query principalId -o tsv`). Until then the register job fails closed with that instruction; dev is already rolled, and **Re-run failed jobs** works after the apply.
- Whoever can run workflows (write access) can put any branch of this repository on the Pixel Dev bot and so act as it in the test guild. That was already true of `terraform.yml`'s use of Environment `dev`; the bot has no reach into prod. If that is too loose, add required reviewers to Environment `dev`.
- A deploy replaces whatever `pixel-dev` runs, including a laptop `just deploy dev`. Say so in the team chat before running one.
- `:dev` and `:<sha>` may be overwritten by a later build of the same SHA, as with `just deploy dev`.
