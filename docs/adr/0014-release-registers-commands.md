# 0014. Releases register prod slash commands

* Status: accepted
* Date: 2026-10-14

## Context

ADR 0012 kept registration a laptop command, and ADR 0013 kept it there: after a release that changes commands, a maintainer still ran `just register prod` with a `.env.prod`. Forgetting that step leaves Discord showing the old command list against the new code. The GitHub identity `pixel-github-prod` was Contributor on `pixel-prod`, which cannot read Key Vault secrets, so CD had no token to register with.

## Decision

- **A `register-prod` job** in [`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs after `prod-cd` rolls `pixel-prod`, in GitHub Environment `prod`. It reads `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `PIXEL_ENV` and the `discord-token` Key Vault reference **from the running Container App**, so it can only register the bot that was just rolled, and refuses unless `PIXEL_ENV=prod`. It fetches the token, masks it, and runs `just register-ci prod`.
- **`just register-ci`** runs only in GitHub Actions. It builds the command list from `config/*.example.yaml` and a throwaway data dir: the commands don't depend on who is in the access lists, so CI never needs the real lists.
- **Least privilege:** `pixel-github-prod` gets **Key Vault Secrets User on the `discord-token` secret only** (`github_register_principal_id` in `infra/envs/prod`, off when null). It still cannot read `admins-yaml`, the Home Assistant token or any other secret, so the prod Terraform plan still runs with `-refresh=false`.
- `just register prod` with `.env.prod` stays as the fallback and for rollbacks.

This **supersedes** the registration clauses of ADR 0012 and ADR 0013. Everything else in them stands.

## Consequences

- A maintainer applies `infra/envs/prod` once with `github_register_principal_id` set (`terraform -chdir=infra/bootstrap output github_principal_ids`). Until then the job fails closed with that instruction; prod is already rolled, and **Re-run failed jobs** works after the apply.
- The job uses Environment `prod` (its OIDC subject is `environment:prod`), so a reviewer approves it as a second step after `prod-cd`.
- The prod bot token is readable by a workflow job on `main` after approval, not only by the app. A compromised workflow could act as the bot in the guild, but could not change access lists, Home Assistant or Azure beyond what Contributor already allowed.
