# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json
RUN pnpm prune --prod

FROM node:24-slim AS runtime
ARG PIXEL_VERSION=dev
# The commit and branch the image was built from, shown when Pixel says it's online.
ARG PIXEL_GIT_SHA=""
ARG PIXEL_GIT_BRANCH=""
ENV NODE_ENV=production \
    PIXEL_VERSION=${PIXEL_VERSION} \
    PIXEL_GIT_SHA=${PIXEL_GIT_SHA} \
    PIXEL_GIT_BRANCH=${PIXEL_GIT_BRANCH}
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Reviewed, public content (the /info topics) is baked into the image; changing it means a deploy.
COPY content ./content
# Access lists are mounted at runtime (Key Vault secret volume); never baked in.
# Runtime state goes in /app/data. Mount a persistent volume there: it holds
# schedules.yaml (the scheduled posts, which are lost without one), plus small state
# files whose loss only costs details like the "open for 2h" time.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.js", "dist/index.js"]
