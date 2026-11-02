# Maintainers

How Pixel is built, secured and run. These pages are the same files as `docs/` in the [repository](https://github.com/pixelbar/pixel/tree/main/docs), so they change in the same pull request as the code they describe.

::: tip New to running Pixel?
Read the [operations runbook](./runbook) first. It covers access lists, moderation, deploys, secrets, incidents and privacy requests.
:::

## Start here

| Page | What it covers |
| --- | --- |
| [Architecture](./architecture) | The design, the phase 1 scope, configuration, deployment and CI/CD pipelines. |
| [Identity and access](./identity-and-access) | Tiers, capabilities and how every command is authorised. Read it before touching anything auth-related. |
| [Infrastructure](./infra) | How Azure, GitHub, Discord, Home Assistant and Sentry fit together. |
| [Home Assistant](./home-assistant) | Setup on a test instance, the threat model and revoking the token. |
| [Operations runbook](./runbook) | Day-to-day tasks and what to do when something breaks. |
| [Privacy notice](/privacy) | What Pixel stores about people, why, where and for how long, and how to ask for a copy or deletion. |
| [Hiding commands in Discord](./discord-command-visibility) | Showing admin commands only to admins. |

## Decisions

Architecture decision records, newest last.

| ADR | Decision |
| --- | --- |
| [0001](./adr/0001-ports-and-adapters) | TypeScript, ports-and-adapters core, interactive vs publisher adapters. |
| [0002](./adr/0002-yaml-access-lists) | Phase 1 tiers from gitignored YAML files; admins in a separate file; fail closed. |
| [0003](./adr/0003-no-database) | No database: access, schedules and planned linking are files. |
| [0004](./adr/0004-azure-container-apps) | Azure Container Apps, single replica; GHCR; dev + prod. |
| [0005](./adr/0005-sentry-and-pino) | Sentry for errors, pino to stdout, a rotating file and Sentry Logs. |
| [0008](./adr/0008-terraform-bootstrap) | Terraform bootstrap: remote state and GitHub OIDC. |
| [0009](./adr/0009-container-apps-dev) | Container Apps module and the `dev` environment. |
| [0010](./adr/0010-ghcr-cd) | Temporary GHCR CD: local `dev`, `main` publishes only. |
| [0011](./adr/0011-home-assistant) | Home Assistant: official client, allow-list, no inbound webhooks. |
| [0012](./adr/0012-prod-environment) | Prod environment and approved CD. |
| [0013](./adr/0013-release-workflow) | Releases cut versions and promote prod. |
| [0014](./adr/0014-release-registers-commands) | Releases register prod slash commands. |
| [0015](./adr/0015-secrets-manifest) | One manifest lists every Key Vault secret. |
| [0016](./adr/0016-secrets-sync) | `just pull` / `just push` (and `secrets-pull` / `secrets-push`) sync tfvars and app secrets between Key Vault and the laptop. |
| [0017](./adr/0017-one-writer-for-app-secrets) | Only the sync tool writes app secrets; Terraform writes just the infra group. |
| [0018](./adr/0018-deploy-dev-workflow) | The Deploy dev workflow puts a branch or same-repo PR on `pixel-dev` when a maintainer runs it. |
| [0019](./adr/0019-level-capabilities) | Capabilities can be granted to a whole membership level (`tiers:` in `members.yaml`). |
| [0020](./adr/0020-two-way-role-sync) | Discord's member and friend roles are synced back into `members.yaml`, only through the access store. |
| [0021](./adr/0021-parking-files) | Parking spots, opening times and bookings are three files in `PIXEL_DATA_DIR`, one per rate of change. |
| [0022](./adr/0022-openr-doors) | OpenR doors and the parking gate: one Pixel account, logged in by an admin and kept alive by Pixel. |

## Working on the site

The site lives in `docs/` and is built with [VitePress](https://vitepress.dev). It has its own `package.json` and lockfile, so nothing it needs reaches the bot's image.

```sh
just docs-install   # once
just docs-dev       # http://localhost:5173 with hot reload
just docs-build     # the static site, in docs/.vitepress/dist
```

- The guide and command pages are written for people using Pixel. Keep them in the design system's voice: plain, friendly, exact, and no emoji.
- A new maintainer doc in `docs/` needs a line in `MAINTAINER_DOCS` and the sidebar in `docs/.vitepress/config.ts`. A new ADR in `docs/adr/` only needs the sidebar.
- Links to files outside `docs/` (`../src/…`, `../justfile`) are turned into links to GitHub when the site is built.
- **Publishing:** the [Docs site workflow](https://github.com/pixelbar/pixel/blob/main/.github/workflows/docs.yml) builds the site on every pull request that touches `docs/`. GitHub Pages is published as part of a [Release](https://github.com/pixelbar/pixel/blob/main/.github/workflows/release.yml) (or by running Docs site by hand). A dead link fails the build.
- The theme is in `docs/.vitepress/theme/`. Its colours, type and spacing come from the Pixel design system: change them there first, then here.
