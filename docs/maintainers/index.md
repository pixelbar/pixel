# Maintainers

How Pixel is built, secured and run. These pages are the same files as `docs/` in the [repository](https://github.com/pixelbar/pixel/tree/main/docs), so they change in the same pull request as the code they describe.

::: tip New to running Pixel?
Read the [operations runbook](./runbook) first. It covers access lists, moderation, deploys, secrets, incidents and privacy requests.
:::

## Start here

| Page | What it covers |
| --- | --- |
| [Architecture](./architecture) | The design, the phase 1 scope, configuration and deployment. |
| [Identity and access](./identity-and-access) | Tiers, capabilities and how every command is authorised. Read it before touching anything auth-related. |
| [Infrastructure](./infra) | How Azure, GitHub, Discord, Home Assistant and Sentry fit together. |
| [Home Assistant](./home-assistant) | Setup on a test instance, the threat model and revoking the token. |
| [Operations runbook](./runbook) | Day-to-day tasks and what to do when something breaks. |
| [Hiding commands in Discord](./discord-command-visibility) | Showing admin commands only to admins. |

## Decisions

Architecture decision records, newest last.

| ADR | Decision |
| --- | --- |
| [0008](./adr/0008-terraform-bootstrap) | Terraform bootstrap: remote state and GitHub OIDC. |
| [0009](./adr/0009-container-apps-dev) | Container Apps module and the `dev` environment. |
| [0010](./adr/0010-ghcr-cd) | Temporary GHCR CD: local `dev`, `main` publishes only. |
| [0011](./adr/0011-home-assistant) | Home Assistant: official client, allow-list, no inbound webhooks. |
| [0012](./adr/0012-prod-environment) | Prod environment and approved CD. |

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
- **Publishing:** the [Docs site workflow](https://github.com/pixelbar/pixel/blob/main/.github/workflows/docs.yml) builds the site on every pull request that touches `docs/`, and publishes it to GitHub Pages when such a change reaches `main`. A dead link fails the build.
- The theme is in `docs/.vitepress/theme/`. Its colours, type and spacing come from the Pixel design system: change them there first, then here.
