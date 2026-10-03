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
ENV NODE_ENV=production \
    PIXEL_VERSION=${PIXEL_VERSION}
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Access lists are mounted at runtime (Key Vault secret volume); never baked in.
# Runtime state (space.state, announcements.state) goes in /app/data. Mount a volume
# there for it to survive new deploys; without one it resets, which only costs the
# "open for 2h" detail and the live post's remembered ID (Pixel then searches the channel).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.js", "dist/index.js"]
