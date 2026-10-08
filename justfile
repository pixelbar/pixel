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

# Everything CI runs for the Node app: lint, types, tests with coverage thresholds
check: lint typecheck coverage

# Format-check and validate bootstrap + envs/dev (needs Terraform 1.9+; CI runs this when infra/ changes)
tf-validate:
    terraform fmt -check -recursive infra
    terraform -chdir=infra/bootstrap init -backend=false -input=false
    terraform -chdir=infra/bootstrap validate
    terraform -chdir=infra/envs/dev init -backend=false -input=false
    terraform -chdir=infra/envs/dev validate

# Plan an env stack (dev). Needs Azure CLI signed in. Does not apply.
tf-plan env:
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} plan

# Apply an env stack. Do not run until a maintainer says so. Never start a
# second Pixel on the same Discord token.
tf-apply env:
    terraform -chdir=infra/envs/{{env}} init -backend-config=backend.azurerm.example.hcl -input=false
    terraform -chdir=infra/envs/{{env}} apply

# Validate the access list files and the Home Assistant devices file
validate-config:
    pnpm exec tsx scripts/validate-config.ts "${PIXEL_ADMINS_FILE:-config/admins.yaml}" "${PIXEL_MEMBERS_FILE:-config/members.yaml}" "${PIXEL_HOME_ASSISTANT_DIR:-config/home-assistant}"

# Register slash commands on the configured Discord guild
register:
    pnpm exec tsx --env-file=.env scripts/register-commands.ts

# Show admin-tier commands to the people in admins.yaml (run after `register`; needs a one-off sign-in as a server manager)
command-access:
    pnpm exec tsx --env-file=.env scripts/command-access.ts

# Build the container image
docker-build tag="pixel:local":
    docker build \
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
      --build-arg PIXEL_VERSION="${version}" \
      --build-arg PIXEL_GIT_SHA="${sha}" \
      --build-arg PIXEL_GIT_BRANCH="${branch}" \
      -t "${pin}" \
      -t "${image_name}:dev" \
      .
    if docker run --rm --entrypoint sh "${pin}" -c 'test -e /app/.env || test -e /app/config/admins.yaml || test -e /app/config/members.yaml'; then
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
    echo "Do not run just dev against the Pixel Dev token while this app is up."
