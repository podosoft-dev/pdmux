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

FROM oven/bun:1.4.4-alpine AS agent-build
COPY --from=golang:1.26.5-alpine /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
WORKDIR /src
COPY agent ./agent
COPY tools/build-agent-binaries.mjs ./tools/
RUN bun tools/build-agent-binaries.mjs && mv apps/web/static/agent /agent

# Both release architectures consume the exact same signed agent bytes.
FROM ${AGENT_ARTIFACTS_BASE} AS agent

FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
ARG PODOKIT_BUILD_ORIGIN
ENV PODOKIT_BUILD_ORIGIN=${PODOKIT_BUILD_ORIGIN}
COPY --from=deps /app ./
COPY . .
# Vite copies static assets into the adapter output, so the release binaries must
# exist before the web build starts.
COPY --from=agent /agent ./apps/web/static/agent
RUN chmod -R a+rX ./apps/web/static/agent
RUN if [ -d packages ]; then \
      for manifest in packages/*/package.json; do \
        [ -e "$manifest" ] || continue; \
        bun run --cwd "$(dirname "$manifest")" --if-present build; \
      done; \
    fi
RUN bun run --cwd apps/web build
RUN mkdir -p /app/packages

FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BODY_SIZE_LIMIT=3M
# ⚠ NO IDLE TIMEOUT. File transfers have no /api proxy deadline: a commit can wait
# five minutes for the agent behind the host's transfer lock, and Bun allows at
# most 255 seconds. See docs/FILE-TRANSFERS.md.
ENV CONNECTION_IDLE_TIMEOUT=0
COPY --from=build /app/apps/web/build ./apps/web/build
WORKDIR /app/apps/web
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '3000') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "./build"]
