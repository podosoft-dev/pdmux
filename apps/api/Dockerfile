# syntax=docker/dockerfile:1
ARG AGENT_ARTIFACTS_BASE=agent-build

FROM oven/bun:1.4.4-alpine AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /app \
    && cp package.json bun.lock bunfig.toml /app/ \
    && find . -name package.json -not -path "*/node_modules/*" \
         -exec sh -c 'mkdir -p "/app/$(dirname "$1")" && cp "$1" "/app/$1"' _ {} \;

FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN bun ci

FROM oven/bun:1.4.4-alpine AS prod-deps
WORKDIR /app
COPY --from=manifests /app ./
# --production alone still installs peer dependencies, and Bun satisfies an
# optional peer whenever the lockfile already resolves it for another workspace.
# Better Auth's optional peers (vitest, svelte, @sveltejs/kit) and
# @better-auth/electron's (electron) then pulled the web, ui and desktop
# toolchains into this image. The API is bundled; only the modules the bundles
# and compiled migrations load at runtime need to be here, and those are all
# regular dependencies of apps/api.
RUN bun install --production --omit=peer --frozen-lockfile --filter './apps/api'

FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY --from=deps /app ./
COPY . .
RUN if [ -d packages ]; then \
      for manifest in packages/*/package.json; do \
        [ -e "$manifest" ] || continue; \
        bun run --cwd "$(dirname "$manifest")" --if-present build; \
      done; \
    fi
RUN bun run --cwd apps/api build
RUN mkdir -p /app/packages

FROM oven/bun:1.4.4-alpine AS agent-build
COPY --from=golang:1.26.5-alpine /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
WORKDIR /src
COPY agent ./agent
COPY tools/build-agent-binaries.mjs ./tools/
RUN bun tools/build-agent-binaries.mjs && mv apps/web/static/agent /agent

# Releases override this stage with the shared, already signed artifact context.
FROM ${AGENT_ARTIFACTS_BASE} AS agent

FROM oven/bun:1.4.4-alpine AS agent-manifests
COPY --from=agent /agent /agent
RUN find /agent -type f ! -name manifest.json -delete && chmod -R a+rX /agent

FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=manifests /app/apps/api ./apps/api
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=agent-manifests /agent ./agent-releases
ENV AGENT_RELEASE_DIR=/app/agent-releases
ENV FILE_TRANSFER_DIR=/data/file-transfers
RUN mkdir -p /data/file-transfers && chown bun:bun /data/file-transfers && chmod 700 /data/file-transfers
WORKDIR /app/apps/api
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3000') + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "dist/main.js"]
