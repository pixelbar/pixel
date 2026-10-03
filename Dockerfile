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
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.js", "dist/index.js"]
