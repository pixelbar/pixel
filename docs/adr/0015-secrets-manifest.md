# 0015. A secrets manifest is the one list of Key Vault secrets

* Status: accepted (the sync tool is [ADR 0016](0016-secrets-sync.md); [ADR 0017](0017-one-writer-for-app-secrets.md) makes it the only writer of the `app` group)
* Date: 2026-10-15

## Context

Which secrets Pixel keeps in Azure Key Vault was written down in several places at once: the Terraform locals (`kv_secret_names`, `pixel_secret_env`), the write-only entries in `secrets.tf`, the module and stack variables, `src/config.ts`, `.env.example`, the architecture config table and the runbook. Adding a secret (`/spacestate` needed two) meant editing all of them, and nothing failed when one was missed. A Key Vault sync tool, so that maintainers stop pasting values through Terraform variables, needs the same list and would be a seventh copy.

## Decision

- **[`infra/secrets.manifest.yaml`](../../infra/secrets.manifest.yaml) is the single source of truth.** Per secret: its Key Vault name (`vault`), a `group`, how it is `delivery`ed, the environment variable (`env`), the `feature` that turns it on, and a description. It holds names and metadata only, never a value.
- **Two groups.** `app` secrets belong to the Pixel app and are what the sync tool will manage. `infra` secrets (`tailscale-auth-key`, `ghcr-pull-token`) belong to the platform around it, and Terraform keeps writing them.
- **Terraform reads the manifest.** `infra/modules/pixel/locals.tf` derives `kv_secret_names` and `pixel_secret_env` from it with `yamldecode`. The only thing still written in HCL is the condition behind each feature name (`secret_features`).
- **[`scripts/secrets-manifest.ts`](../../scripts/secrets-manifest.ts) loads and validates it** (`just validate-secrets`). It collects every problem, and never repeats a value from the file.
- **A parity test fails on drift.** `scripts/secrets-manifest.test.ts` checks the manifest against `secrets.tf`, the Terraform variables (ephemeral and sensitive, in the module and both stacks), `config.ts`, `.env.example`, the architecture config table, the runbook and the infra doc, and names whatever is missing.
- **Terraform still writes the values for now.** Moving the app group's values to a sync tool is a later change.

## Consequences

- Adding a secret is one manifest entry plus the places the test names; forgetting one fails `just check`.
- The Terraform output is unchanged: the manifest-driven logic gives the same secrets and environment variables as the old locals for every combination of features.
- The parity test reads Terraform, docs and `.env.example`, so those paths are in the `check` allowlist of `.github/path-filters.yml`.
- A new feature condition needs a line in `secret_features` as well as in the manifest. The test catches a mismatch.
