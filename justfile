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

# Format-check and validate infra/bootstrap (needs Terraform 1.9+; CI runs this when infra/ changes)
tf-validate:
    terraform fmt -check -recursive infra
    terraform -chdir=infra/bootstrap init -backend=false -input=false
    terraform -chdir=infra/bootstrap validate

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
