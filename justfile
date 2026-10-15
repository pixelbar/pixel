set dotenv-load

# List recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Run Pixel locally with hot reload (also restarts when access lists change)
dev:
    pnpm exec tsx watch --include 'config/*.yaml' --env-file=.env --import ./src/instrument.ts src/index.ts

# Compile TypeScript to dist/
build:
    rm -rf dist
    pnpm exec tsc -p tsconfig.build.json

# Run the compiled build (after `just build`)
start:
    node --env-file=.env --import ./dist/instrument.js dist/index.js

# Run tests (pass extra args through, e.g. `just test --watch`)
test *args:
    pnpm exec vitest run {{args}}

# Run tests with coverage; fails below the thresholds in vitest.config.ts
coverage:
    pnpm exec vitest run --coverage

# Lint and check formatting
lint:
    pnpm exec biome check .

# Fix formatting and safe lint issues
fmt:
    pnpm exec biome check --write .
    -terraform fmt -recursive infra

# Type-check everything, including tests and scripts
typecheck:
    pnpm exec tsc --noEmit

# Everything CI runs for the Node app: lint, types, tests with coverage thresholds.
# GitHub runs this only when a check-path matches (.github/path-filters.yml).
check: lint typecheck coverage

# Fail unless this branch updates CHANGELOG.md vs the base (default origin/main).
# CI sets SKIP_CHANGELOG when the PR has the skip-changelog label.
check-changelog *args:
    pnpm exec tsx scripts/check-changelog.ts {{args}}

# Cut [Unreleased] into a dated version and bump package.json.
# Added → minor; Fixed/Changed → patch. Never major before 1.0.
# `--commit` also creates the release commit and tag (used by the Release workflow).
# `--notes-file PATH` writes the GitHub Release body for the cut (or current) version.
bump *args:
    pnpm exec tsx scripts/bump-version.ts {{args}}

# Format-check and validate bootstrap + envs/dev + envs/prod (needs Terraform 1.11+; CI runs this when infra/ changes)
tf-validate:
    terraform fmt -check -recursive infra
    terraform -chdir=infra/bootstrap init -backend=false -input=false
    terraform -chdir=infra/bootstrap validate
    terraform -chdir=infra/envs/dev init -backend=false -input=false
    terraform -chdir=infra/envs/dev validate
    terraform -chdir=infra/envs/prod init -backend=false -input=false
    terraform -chdir=infra/envs/prod validate

# Plan an env stack (dev or prod). Needs Azure CLI signed in. Does not apply.
tf-plan env:
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} plan

# Apply an env stack. Do not run until a maintainer says so. Never start a
# second Pixel on the same Discord token. On dev, after first create this
# does not change the Pixel container image (just deploy-dev / az owns that
# pin). Prod apply still sets container_image. Coding agents must not apply
# prod: PIXEL_APPLY_PROD=1 is required.
tf-apply env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{env}}" = "prod" ] && [ "${PIXEL_APPLY_PROD:-}" != "1" ]; then
      echo "Refusing just tf-apply prod. Coding agents must not apply prod or write prod secrets."
      echo "A maintainer runs: PIXEL_APPLY_PROD=1 just tf-apply prod"
      exit 1
    fi
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} apply

# Validate the access list files and the Home Assistant devices file
validate-config:
    pnpm exec tsx scripts/validate-config.ts "${PIXEL_ADMINS_FILE:-config/admins.yaml}" "${PIXEL_MEMBERS_FILE:-config/members.yaml}" "${PIXEL_HOME_ASSISTANT_DIR:-config/home-assistant}"

# Validate infra/secrets.manifest.yaml (names only; no Azure login, no values)
validate-secrets:
    pnpm exec tsx scripts/validate-secrets.ts

# Load `.env.dev` or `.env.prod` for a Discord laptop script. just dotenv-load
# would otherwise let `.env` win over Node `--env-file`. Dev falls back to `.env`.
[private]
discord-env env script:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{env}}" != "dev" ] && [ "{{env}}" != "prod" ]; then
      echo "Usage: just register|command-access|ha-devices dev|prod"
      exit 1
    fi
    file=".env.{{env}}"
    if [ "{{env}}" = "dev" ] && [ ! -f "${file}" ] && [ -f .env ]; then
      file=".env"
      echo "Using .env (no .env.dev). Copy .env.example to .env.dev to keep Pixel Dev separate from a local bot."
    fi
    if [ ! -f "${file}" ]; then
      echo "Missing ${file}."
      if [ "{{env}}" = "prod" ]; then
        echo "Copy .env.example to .env.prod and set PIXEL_ENV=prod plus the production Discord application. Never copy .env or .env.dev."
      else
        echo "Copy .env.example to .env.dev and fill in the Pixel Dev / test Discord application."
      fi
      exit 1
    fi
    # Node --env-file does not override existing variables. Drop anything
    # dotenv-load took from .env so it cannot leak into the other bot.
    for src in .env .env.dev .env.prod; do
      if [ -f "${src}" ]; then
        while IFS= read -r key; do
          unset "${key}" || true
        done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${src}" | cut -d= -f1)
      fi
    done
    pnpm exec tsx --env-file="${file}" {{script}} "{{env}}"

# Register slash commands: `just register dev` or `just register prod`
register env:
    @just discord-env {{env}} scripts/register-commands.ts

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
      pnpm exec tsx scripts/register-commands.ts "{{env}}"

# Create a Sentry release and upload dist/ maps. Skip (do not fail) if
# SENTRY_AUTH_TOKEN, SENTRY_ORG, or SENTRY_PROJECT is unset — do not invent
# an org. Pixel itself does not read these; they are for this recipe and CD.
# `version` must match PIXEL_VERSION in the running image (git SHA on main).
# Pass environment=dev after a real deploy; omit it for publish-only.
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
command-access env:
    @just discord-env {{env}} scripts/command-access.ts

# Add Home Assistant devices to an env's devices.yaml on Azure: `just ha-devices dev|prod`.
# Pulls the remote file (the truth), mirrors it to config/home-assistant/<env>/,
# lets you pick from what Home Assistant has, validates, and pushes on a yes.
# Needs az login, and HOME_ASSISTANT_URL/TOKEN in that env's file. Then /admin reload.
ha-devices env:
    @just discord-env {{env}} scripts/ha-devices.ts

# Which secrets: the `app` group in infra/secrets.manifest.yaml. Never prints a value.
# Asks before overwriting a local edit. Needs az login. See docs/runbook.md#secrets.
# Pull an env's Key Vault secrets into .env.<env> + config/admins.<env>.yaml to edit them
secrets-pull env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} pull

# Reads the vault (the live values), shows what would change by name and length, pushes
# on a yes if the vault hasn't changed meanwhile, reads it back, then offers `just restart`.
# Push local secrets to an env's Key Vault after showing the diff: `just secrets-push dev|prod`
secrets-push env:
    pnpm exec tsx scripts/secrets-sync.ts {{env}} push

# Restarts the running revision in place (one replica); it doesn't deploy anything.
# Restart an env's Container App so it reads its secrets again: `just restart dev|prod`
restart env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{env}}" != "dev" ] && [ "{{env}}" != "prod" ]; then
      echo "Usage: just restart dev|prod"
      exit 1
    fi
    subscription="d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
    resource_group="pixel-{{env}}"
    app_name="pixel-{{env}}"
    current_sub="$(az account show --query id -o tsv)"
    if [ "${current_sub}" != "${subscription}" ]; then
      echo "az is not on the Pixel subscription (${subscription}). Run: az account set --subscription ${subscription}"
      exit 1
    fi
    revision="$(az containerapp show -g "${resource_group}" -n "${app_name}" --query properties.latestRevisionName -o tsv)"
    echo "Restarting ${revision} (${app_name})…"
    az containerapp revision restart -g "${resource_group}" -n "${app_name}" --revision "${revision}" --only-show-errors --output none
    echo "Restarted. Check /ping in the {{env}} server, and /admin status."

# Build the container image for Azure (linux/amd64). Mini is arm64; Container
# Apps reject arm64 images.
docker-build tag="pixel:local":
    docker build \
      --platform linux/amd64 \
      --build-arg PIXEL_VERSION=$(git rev-parse --short HEAD) \
      --build-arg PIXEL_GIT_SHA=$(git rev-parse HEAD) \
      --build-arg PIXEL_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
      -t {{tag}} .

# Log in to GHCR. Needs `gh auth refresh --scopes write:packages,read:packages,repo`.
docker-login-ghcr:
    #!/usr/bin/env bash
    set -euo pipefail
    user="$(gh api user --jq .login)"
    echo "$(gh auth token)" | docker login ghcr.io -u "${user}" --password-stdin

# Does not start Pixel. Needs docker, gh (write:packages), and az on the Pixel subscription.
# If pixel-dev is up, do not also run `just dev` on the same Discord token.
# Build this tree, push to GHCR, roll onto Azure pixel-dev. Never prod.
deploy-dev: docker-login-ghcr
    #!/usr/bin/env bash
    set -euo pipefail
    image_name="ghcr.io/pixelbar/pixel"
    sha="$(git rev-parse HEAD)"
    short="$(git rev-parse --short HEAD)"
    branch="$(git rev-parse --abbrev-ref HEAD)"
    subscription="d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
    resource_group="pixel-dev"
    app_name="pixel-dev"
    if [ "${resource_group}" != "pixel-dev" ] || [ "${app_name}" != "pixel-dev" ]; then
      echo "Refusing to deploy: this recipe only updates pixel-dev, never prod."
      exit 1
    fi
    version="${short}"
    pin="${image_name}:${sha}"
    if [ -n "$(git status --porcelain)" ]; then
      version="${short}-dirty"
      pin="${image_name}:dev-dirty-$(date -u +%Y%m%dT%H%M%SZ)"
      echo "Working tree is dirty; tagging ${pin} instead of ${sha}."
    fi
    current_sub="$(az account show --query id -o tsv)"
    if [ "${current_sub}" != "${subscription}" ]; then
      echo "az is not on the Pixel subscription (${subscription}). Run: az account set --subscription ${subscription}"
      exit 1
    fi
    docker build \
      --platform linux/amd64 \
      --build-arg PIXEL_VERSION="${version}" \
      --build-arg PIXEL_GIT_SHA="${sha}" \
      --build-arg PIXEL_GIT_BRANCH="${branch}" \
      -t "${pin}" \
      -t "${image_name}:dev" \
      .
    if docker run --rm --platform linux/amd64 --entrypoint sh "${pin}" -c 'test -e /app/.env || test -e /app/config/admins.yaml || test -e /app/config/members.yaml'; then
      echo "Image ${pin} contains .env or access lists. Not pushing."
      exit 1
    fi
    docker push "${pin}"
    docker push "${image_name}:dev"
    if ! az containerapp show -g "${resource_group}" -n "${app_name}" >/dev/null 2>&1; then
      echo "Container App ${app_name} is not in ${resource_group} yet (#9). Image ${pin} was pushed. Apply infra/envs/dev, then re-run. This recipe does not apply Terraform."
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
    if [ "${PIXEL_ENV:-local}" = "prod" ]; then
      echo "Refusing just register: PIXEL_ENV=prod. deploy-dev is the Pixel Dev guild only. Never copy a prod token into this path."
      exit 1
    fi
    # Register before Sentry: the app is already live. A Sentry outage must not
    # skip Discord command updates. sentry-release still fails the recipe.
    just register dev
    just build
    if ! just sentry-release "${version}" dev; then
      echo "Sentry release failed after Discord commands were registered. pixel-dev is already on ${pin}."
      exit 1
    fi
    echo "Do not run just dev against the Pixel Dev token while this app is up."

# Install the website's dependencies (docs/ is its own project with its own lockfile)
docs-install:
    pnpm --dir docs install

# Run the website locally with hot reload (http://localhost:5173)
docs-dev:
    pnpm --dir docs run dev

# Build the website into docs/.vitepress/dist
docs-build:
    pnpm --dir docs run build

# Serve the built website (after `just docs-build`)
docs-preview:
    pnpm --dir docs run preview

# Build the website and share it on your tailnet with `tailscale serve` (never Funnel:
# only devices on your tailnet can open it). Runs until Ctrl-C, which also stops sharing.
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
