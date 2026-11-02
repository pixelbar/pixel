set dotenv-load

# List recipes
default:
    @just --list

# Install dependencies
[group('develop')]
install:
    pnpm install

# Run Pixel locally with hot reload (also restarts when access lists change)
[group('develop')]
dev:
    pnpm exec tsx watch --include 'config/*.yaml' --env-file=.env --import ./src/instrument.ts src/index.ts

# Compile TypeScript to dist/
[group('develop')]
build:
    rm -rf dist
    pnpm exec tsc -p tsconfig.build.json

# Run the compiled build (after `just build`)
[group('develop')]
start:
    node --env-file=.env --import ./dist/instrument.js dist/index.js

# Run tests (pass extra args through, e.g. `just test --watch`)
[group('develop')]
test *args:
    pnpm exec vitest run {{args}}

# Run tests with coverage; fails below the thresholds in vitest.config.ts
[group('develop')]
coverage:
    pnpm exec vitest run --coverage

# Lint and check formatting
[group('develop')]
lint:
    pnpm exec biome check .

# Fix formatting and safe lint issues
[group('develop')]
fmt:
    pnpm exec biome check --write .
    -terraform fmt -recursive infra

# Type-check everything, including tests and scripts
[group('develop')]
typecheck:
    pnpm exec tsc --noEmit

# Everything CI runs for the Node app: lint, types, tests with coverage thresholds.
# GitHub skips it when the `check` inputs already passed (.github/path-filters.yml).
[group('develop')]
[doc("Everything CI runs for the Node app: lint, types, tests with coverage thresholds")]
check: lint typecheck coverage

# The files a CI job depends on (a list in .github/path-filters.yml), and the
# hash CI uses to skip the job when they already passed: just ci-inputs check
[group('develop')]
[doc("Show the files a CI job depends on and the hash CI uses to skip it: `just ci-inputs check`")]
ci-inputs filter:
    bash scripts/ci-inputs.sh --list {{filter}}
    @echo "hash (CI also adds the workflow file): $(bash scripts/ci-inputs.sh {{filter}})"

# Fail unless this branch updates CHANGELOG.md vs the base (default origin/main).
# CI sets SKIP_CHANGELOG when the PR has the skip-changelog label.
[group('release')]
[doc("Fail unless this branch updates CHANGELOG.md vs the base (default origin/main)")]
check-changelog *args:
    node scripts/check-changelog.ts {{args}}

# In a merge or rebase that stopped on CHANGELOG.md: keep both sides' [Unreleased]
# entries when that is clearly right, and stage the file. Says why when it won't.
[group('release')]
[doc("Resolve a CHANGELOG.md conflict by keeping both sides' [Unreleased] entries")]
changelog-merge:
    node scripts/merge-changelog.ts --git

# Let git do `just changelog-merge` by itself whenever CHANGELOG.md conflicts
# (this clone only; nothing is committed). Undo: git config --unset merge.changelog.driver
[group('release')]
[doc("Let git run `just changelog-merge` on CHANGELOG.md conflicts (this clone only)")]
changelog-merge-driver:
    git config merge.changelog.name "Keep both sides' CHANGELOG [Unreleased] entries"
    git config merge.changelog.driver "node scripts/merge-changelog.ts %O %A %B"
    grep -qxF 'CHANGELOG.md merge=changelog' "$(git rev-parse --git-path info/attributes)" 2>/dev/null || \
        echo 'CHANGELOG.md merge=changelog' >> "$(git rev-parse --git-path info/attributes)"

# Cut [Unreleased] into a dated version and bump package.json.
# Added → minor; Fixed/Changed → patch. Never major before 1.0.
# `--commit` also creates the release commit and tag (used by the Release workflow).
# `--notes-file PATH` writes the GitHub Release body for the cut (or current) version.
[group('release')]
[doc("Cut [Unreleased] into a dated version and bump package.json")]
bump *args:
    pnpm exec tsx scripts/bump-version.ts {{args}}

# Format-check and validate bootstrap + envs/dev + envs/prod (needs Terraform 1.11+; CI runs this when infra/ changes)
[group('terraform')]
tf-validate:
    terraform fmt -check -recursive infra
    terraform -chdir=infra/bootstrap init -backend=false -input=false
    terraform -chdir=infra/bootstrap validate
    terraform -chdir=infra/envs/dev init -backend=false -input=false
    terraform -chdir=infra/envs/dev validate
    terraform -chdir=infra/envs/prod init -backend=false -input=false
    terraform -chdir=infra/envs/prod validate

# Plan an env stack (dev or prod). Needs Azure CLI signed in. Does not apply.
[group('terraform')]
tf-plan env:
    @pnpm exec tsx scripts/env.ts shell {{env}} >/dev/null
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} plan

# Apply an env stack. Do not run until a maintainer says so. Never start a
# second Pixel on the same Discord token. On dev, after first create this
# does not change the Pixel container image (just deploy-dev / az owns that
# pin). Prod apply still sets container_image. Coding agents must not apply
# prod: PIXEL_APPLY_PROD=1 is required.
[group('terraform')]
[doc("Apply an env stack (maintainers only; prod needs PIXEL_APPLY_PROD=1)")]
tf-apply env:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec tsx scripts/env.ts apply {{env}}
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} apply

# Validate the access list files and the Home Assistant devices file
[group('config')]
validate-config:
    pnpm exec tsx scripts/validate-config.ts "${PIXEL_ADMINS_FILE:-config/admins.yaml}" "${PIXEL_MEMBERS_FILE:-config/members.yaml}" "${PIXEL_HOME_ASSISTANT_DIR:-config/home-assistant}"

# Validate infra/secrets.manifest.yaml (names only; no Azure login, no values)
[group('config')]
validate-secrets:
    pnpm exec tsx scripts/validate-secrets.ts

# Names only, never a secret. Every laptop tool reads these from scripts/envs.ts.
# Show where an env lives (env file, subscription, resource group, app, vault, share): `just env dev`
[group('environments')]
env env:
    @pnpm exec tsx scripts/env.ts show {{env}}

# Register slash commands: `just register dev` or `just register prod`
[group('environments')]
register env:
    pnpm exec tsx scripts/register-commands.ts {{env}}

# The Release workflow's register step (ADR 0014). Reads DISCORD_* and PIXEL_ENV
# from the job, not an env file. The command list doesn't depend on who is in
# the access lists, so it builds from the example lists and a throwaway data dir.
[private]
register-ci env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
      echo "register-ci runs only in GitHub Actions. On a laptop: just register {{env}}"
      exit 1
    fi
    data="$(mktemp -d)"
    trap 'rm -rf "${data}"' EXIT
    PIXEL_ADMINS_FILE=config/admins.example.yaml \
    PIXEL_MEMBERS_FILE=config/members.example.yaml \
    PIXEL_DATA_DIR="${data}" \
    PIXEL_ENV_SOURCE=process \
      pnpm exec tsx scripts/register-commands.ts "{{env}}"

# Create a Sentry release and upload dist/ maps. Skip (do not fail) if
# SENTRY_AUTH_TOKEN, SENTRY_ORG, or SENTRY_PROJECT is unset — do not invent
# an org. Pixel itself does not read these; they are for this recipe and CD.
# `version` must match PIXEL_VERSION in the running image (git SHA on main).
# Pass environment=dev after a real deploy; omit it for publish-only.
[group('release')]
[doc("Create a Sentry release and upload dist/ source maps (skips without SENTRY_* settings)")]
sentry-release version="" environment="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${SENTRY_AUTH_TOKEN:-}" ] || [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ]; then
      echo "Sentry release skipped: set SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT. Not inventing an org (#10)."
      exit 0
    fi
    release="{{version}}"
    if [ -z "${release}" ]; then
      release="$(git rev-parse HEAD)"
    fi
    if [ ! -d dist ]; then
      echo "dist/ is missing; run just build first."
      exit 1
    fi
    run_cli() {
      pnpm dlx --yes @sentry/cli@2.58.2 "$@"
    }
    run_cli releases new "${release}"
    run_cli releases set-commits "${release}" --auto --ignore-missing || true
    run_cli sourcemaps upload --release "${release}" --url-prefix /app/dist dist
    if [ -n "{{environment}}" ]; then
      run_cli deploys new -e "{{environment}}" -r "${release}"
    fi
    run_cli releases finalize "${release}"
    echo "Sentry release ${release}."

# Show admin commands: `just command-access dev` or `just command-access prod`
[group('environments')]
command-access env:
    pnpm exec tsx scripts/command-access.ts {{env}}

# Add Home Assistant devices to an env's devices.yaml on Azure: `just ha-devices dev|prod`.
# Pulls the remote file (the truth), mirrors it to config/home-assistant/<env>/,
# lets you pick from what Home Assistant has, validates, and pushes on a yes.
# Needs az login, and HOME_ASSISTANT_URL/TOKEN in that env's file. Then /admin reload.
[group('environments')]
[doc("Pick Home Assistant devices and push an env's devices.yaml: `just ha-devices dev|prod`")]
ha-devices env:
    pnpm exec tsx scripts/ha-devices.ts {{env}}

# List the OpenR buildings and doors an env's OpenR account can see, with their IDs,
# to fill in OPENR_BUILDING_ID, OPENR_DOORS and OPENR_GATE_DOOR. Logs in with
# OPENR_EMAIL/PASSWORD from that env's file, asks for the emailed code, logs out.
# Read-only: opens nothing, and leaves Pixel's own session alone.
[group('environments')]
[doc("List OpenR buildings and doors with their IDs: `just openr-doors dev|prod`")]
openr-doors env:
    pnpm exec tsx scripts/openr-doors.ts {{env}}

# Pulls terraform-tfvars into infra/envs/<env>/terraform.tfvars, the app secrets (as
# secrets-pull), and read-only mirrors of members.yaml, devices.yaml and announcement-routes.yaml.
# Pull everything for an env (tfvars, secrets, share config) to edit, plan or sync: `just pull dev|prod`
[group('environments')]
pull env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} pull --all

# Diffs against the live vault and pushes on a yes. Refuses tfvars that hold a secret or
# are for the other env. members.yaml goes back to the share too, checked with admins.yaml,
# and only if Pixel hasn't changed it since; the other mirrors never go back up.
# Push an env's tfvars, app secrets and members.yaml after showing the diff: `just push dev|prod`
[group('environments')]
push env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} push --all

# Which secrets: the `app` group in infra/secrets.manifest.yaml. Never prints a value.
# Asks before overwriting a local edit. Needs az login. See docs/runbook.md#secrets.
# Pull an env's Key Vault secrets into .env.<env> + config/admins.<env>.yaml to edit them
[group('environments')]
secrets-pull env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} pull

# Reads the vault (the live values), shows what would change by name and length, pushes
# on a yes if the vault hasn't changed meanwhile, reads it back, then offers `just restart`.
# Push local secrets to an env's Key Vault after showing the diff: `just secrets-push dev|prod`
[group('environments')]
secrets-push env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} push

# Restarts the running revision in place (one replica); it doesn't deploy anything.
# Restart an env's Container App so it reads its secrets again: `just restart dev|prod`
[group('environments')]
restart env:
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(pnpm exec tsx scripts/env.ts shell {{env}})"
    pnpm exec tsx scripts/env.ts check-az {{env}}
    revision="$(az containerapp show -g "${resource_group}" -n "${app_name}" --query properties.latestRevisionName -o tsv)"
    echo "Restarting ${revision} (${app_name})…"
    az containerapp revision restart -g "${resource_group}" -n "${app_name}" --revision "${revision}" --only-show-errors --output none
    echo "Restarted. Check /ping in the {{env}} server, and /admin status."

# Build the container image for Azure (linux/amd64). Mini is arm64; Container
# Apps reject arm64 images.
[group('release')]
[doc("Build the container image for Azure (linux/amd64)")]
docker-build tag="pixel:local":
    docker build \
      --platform linux/amd64 \
      --build-arg PIXEL_VERSION=$(git rev-parse --short HEAD) \
      --build-arg PIXEL_GIT_SHA=$(git rev-parse HEAD) \
      --build-arg PIXEL_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
      -t {{tag}} .

# Log in to GHCR. Needs `gh auth refresh --scopes write:packages,read:packages,repo`.
[group('release')]
docker-login-ghcr:
    #!/usr/bin/env bash
    set -euo pipefail
    user="$(gh api user --jq .login)"
    echo "$(gh auth token)" | docker login ghcr.io -u "${user}" --password-stdin

# Does not start Pixel. Needs docker, gh (write:packages), and az on the Pixel subscription.
# If pixel-dev is up, do not also run `just dev` on the same Discord token. Prod ships
# only from the Release workflow, so `just deploy prod` refuses.
# Build this tree, push to GHCR, roll it onto an env's Container App: `just deploy dev`
[group('environments')]
deploy env:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec tsx scripts/env.ts deploy {{env}}
    eval "$(pnpm exec tsx scripts/env.ts shell {{env}})"
    pnpm exec tsx scripts/env.ts check-az {{env}}
    just docker-login-ghcr
    image_name="ghcr.io/pixelbar/pixel"
    sha="$(git rev-parse HEAD)"
    short="$(git rev-parse --short HEAD)"
    branch="$(git rev-parse --abbrev-ref HEAD)"
    version="${short}"
    pin="${image_name}:${sha}"
    if [ -n "$(git status --porcelain)" ]; then
      version="${short}-dirty"
      pin="${image_name}:dev-dirty-$(date -u +%Y%m%dT%H%M%SZ)"
      echo "Working tree is dirty; tagging ${pin} instead of ${sha}."
    fi
    docker build \
      --platform linux/amd64 \
      --build-arg PIXEL_VERSION="${version}" \
      --build-arg PIXEL_GIT_SHA="${sha}" \
      --build-arg PIXEL_GIT_BRANCH="${branch}" \
      -t "${pin}" \
      -t "${image_name}:{{env}}" \
      .
    if docker run --rm --platform linux/amd64 --entrypoint sh "${pin}" -c 'test -e /app/.env || test -e /app/config/admins.yaml || test -e /app/config/members.yaml'; then
      echo "Image ${pin} contains .env or access lists. Not pushing."
      exit 1
    fi
    docker push "${pin}"
    docker push "${image_name}:{{env}}"
    if ! az containerapp show -g "${resource_group}" -n "${app_name}" >/dev/null 2>&1; then
      echo "Container App ${app_name} is not in ${resource_group} yet (#9). Image ${pin} was pushed. Apply infra/envs/{{env}}, then re-run. This recipe does not apply Terraform."
      exit 1
    fi
    az containerapp update \
      -g "${resource_group}" \
      -n "${app_name}" \
      --image "${pin}" \
      --min-replicas 1 \
      --max-replicas 1
    running="$(az containerapp show -g "${resource_group}" -n "${app_name}" --query "properties.template.containers[0].image" -o tsv)"
    min="$(az containerapp show -g "${resource_group}" -n "${app_name}" --query "properties.template.scale.minReplicas" -o tsv)"
    max="$(az containerapp show -g "${resource_group}" -n "${app_name}" --query "properties.template.scale.maxReplicas" -o tsv)"
    echo "Running ${running} min=${min} max=${max}"
    if [ "${max}" != "1" ] || [ "${min}" != "1" ]; then
      echo "Replica count is not 1 (min=${min} max=${max}). Two bots on one token would answer twice."
      exit 1
    fi
    # Register before Sentry: the app is already live. A Sentry outage must not
    # skip Discord command updates. sentry-release still fails the recipe.
    # just register reads {{env}}'s own env file and refuses one for the other bot.
    just register {{env}}
    just build
    if ! just sentry-release "${version}" {{env}}; then
      echo "Sentry release failed after Discord commands were registered. ${app_name} is already on ${pin}."
      exit 1
    fi
    echo "Do not run just dev against the ${env_file} Discord token while this app is up."

# Runs the Deploy dev workflow (ADR 0018) from main's definition on a PR number,
# branch or SHA; empty means this branch, which must be pushed. Needs gh. Prod refuses.
# Put a PR or branch on an env via GitHub Actions: `just deploy-remote dev 123`
[group('environments')]
deploy-remote env ref="":
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec tsx scripts/env.ts deploy {{env}}
    ref="{{ref}}"
    if [ -z "${ref}" ]; then
      ref="$(git rev-parse --abbrev-ref HEAD)"
      if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}' 2>/dev/null || true)" ]; then
        echo "${ref} is not pushed as it is here. Push it first; the workflow deploys what GitHub has."
        exit 1
      fi
    fi
    gh workflow run deploy-dev.yml --ref main -f ref="${ref}"
    echo "Started Deploy dev for ${ref}. Follow it: gh run watch \$(gh run list --workflow deploy-dev.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# The old name for `just deploy dev`; kept for a release (#116).
[group('environments')]
deploy-dev: (deploy "dev")

# Install the website's dependencies (docs/ is its own project with its own lockfile)
[group('docs')]
docs-install:
    pnpm --dir docs install

# Run the website locally with hot reload (http://localhost:5173)
[group('docs')]
docs-dev:
    pnpm --dir docs run dev

# Build the website into docs/.vitepress/dist
[group('docs')]
docs-build:
    pnpm --dir docs run build

# Serve the built website (after `just docs-build`)
[group('docs')]
docs-preview:
    pnpm --dir docs run preview

# Build the website and share it on your tailnet with `tailscale serve` (never Funnel:
# only devices on your tailnet can open it). Runs until Ctrl-C, which also stops sharing.
[group('docs')]
[doc("Build the website and share it on your tailnet (tailscale serve, never Funnel)")]
docs-tailnet port="4173":
    #!/usr/bin/env bash
    set -euo pipefail
    ts="$(command -v tailscale || true)"
    if [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
      ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
    fi
    if [ -z "$ts" ]; then
      echo "The tailscale CLI isn't installed or on PATH."
      exit 1
    fi
    just docs-build
    pnpm --dir docs exec vitepress preview --port {{port}} &
    preview=$!
    trap 'kill "$preview" 2>/dev/null || true' EXIT
    for _ in $(seq 1 50); do
      curl -fsS -o /dev/null "http://127.0.0.1:{{port}}/" && break
      sleep 0.2
    done
    # Foreground serve: the share is removed when this exits.
    "$ts" serve "http://127.0.0.1:{{port}}"

# Run the website with hot reload and share it on your tailnet with `tailscale serve`
# (never Funnel). Edits show up on the remote device as you save. Ctrl-C stops both.
[group('docs')]
[doc("Run the website with hot reload and share it on your tailnet (never Funnel)")]
docs-tailnet-dev port="5173" https="443":
    #!/usr/bin/env bash
    set -euo pipefail
    ts="$(command -v tailscale || true)"
    if [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
      ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
    fi
    if [ -z "$ts" ]; then
      echo "The tailscale CLI isn't installed or on PATH."
      exit 1
    fi
    # `serve status` hides foreground shares; the JSON shows them. A share left over
    # from a run that didn't exit cleanly holds the port until it's reset.
    if "$ts" serve status --json | grep -q "\"{{https}}\""; then
      echo "Something is already shared on your tailnet's port {{https}}:"
      "$ts" serve status --json
      echo "Stop it, or clear it with \`tailscale serve reset\`, or pick another port: just docs-tailnet-dev {{port}} 8443"
      exit 1
    fi
    pnpm --dir docs exec vitepress dev --host 127.0.0.1 --port {{port}} --strictPort &
    dev=$!
    trap 'kill "$dev" 2>/dev/null || true' EXIT
    for _ in $(seq 1 150); do
      curl -fs -o /dev/null "http://127.0.0.1:{{port}}/" && break
      kill -0 "$dev" 2>/dev/null || { echo "The dev server didn't start."; exit 1; }
      sleep 0.2
    done
    # Foreground serve: the share is removed when this exits. It proxies the HMR
    # websocket too, so hot reload works over https://<machine>.<tailnet>.ts.net/.
    "$ts" serve --https={{https}} "http://127.0.0.1:{{port}}"
