# syntax=docker/dockerfile:1

# The npm that reads package-lock.json must be the major that wrote it. node:22
# bundles npm 10, and a lockfile written by npm 11 records platform-specific
# packages as extraneous with no `optional` flag; npm 10 rejects those with
# EBADPLATFORM instead of skipping them, so `npm ci` fails inside the image while
# `npm install` on the developer's machine is fine. Keep this in step with the npm
# the project is developed with.
ARG NPM_VERSION=11.17.0

# Every workspace manifest, and nothing else.
#
# Listing them by hand only works for the workspaces this template starts with: npm
# does NOT fail when a workspace's package.json is absent, it silently installs a
# tree without that package's dependencies. A project that adds packages/* then
# builds against different versions than it resolves locally, and only inside the
# image. Collecting them keeps `npm ci` correct whatever the workspace layout is,
# and the stages below still cache on the manifests' content.
FROM node:22-alpine AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /app \
    && cp package.json package-lock.json /app/ \
    && find . -name package.json -not -path "*/node_modules/*" \
         -exec sh -c 'mkdir -p "/app/$(dirname "$1")" && cp "$1" "/app/$1"' _ {} \;

FROM node:22-alpine AS deps
WORKDIR /app
COPY --from=manifests /app ./
ARG NPM_VERSION
RUN npm i -g "npm@${NPM_VERSION}"
RUN npm ci --no-audit --no-fund

# Production dependencies only, resolved from the same lockfile. The runtime stage
# copies node_modules from here and never from deps or build, so the shipped image
# does not carry the TypeScript compiler, Vite, or the test tooling.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=manifests /app ./
ARG NPM_VERSION
RUN npm i -g "npm@${NPM_VERSION}"
# The runtime tree for this image only.
#
# Scoping to the one workspace matters: --omit=dev at the root still installs the
# union of every workspace's production dependencies, so the API image carried Vite
# and the web image carried Nest. Measured on a generated project, this is 198
# packages instead of 283. TypeScript stays either way -- typeorm depends on ts-node,
# which depends on it, so it is a production dependency and not bloat.
RUN npm ci --omit=dev --no-audit --no-fund --workspace=apps/api --include-workspace-root

FROM node:22-alpine AS build
WORKDIR /app
# Everything npm ci produced, not just the root node_modules: npm nests any
# dependency it cannot hoist, and copying only the root directory leaves a workspace
# package compiling against the wrong version of it.
COPY --from=deps /app ./
COPY . .
# Local workspace packages compile before the app that imports them. Apps import
# them by their published entry points and .dockerignore excludes dist, so nothing
# here has compiled output until it is compiled here.
RUN if [ -d packages ]; then \
      for manifest in packages/*/package.json; do \
        [ -e "$manifest" ] || continue; \
        npm run build --if-present --workspace "$(dirname "$manifest")"; \
      done; \
    fi
RUN npm run build --workspace=apps/api
# The runtime needs the real workspace package directories, not just the symlinks
# npm leaves in node_modules pointing at them. Without this the image boots and
# dies on "Cannot find module <package>" -- a dangling link, at runtime only.
# mkdir keeps the COPY valid for a project that has no packages/ at all.
RUN mkdir -p /app/packages

# The agent release manifests — WHICH versions exist and what their binaries hash
# to. `AgentReleaseService` reads them to answer "is this host behind" and to fill
# in an `update` frame, and without them it answers "no release": every host's
# version badge goes `unknown` and the dashboard never offers an update. That is
# not a visible failure — `unknown` is the deliberate reading of "we cannot say",
# so the screen looks calm while the feature is simply absent.
#
# ⚠ IT IS INVISIBLE IN A CHECKOUT. The service falls back to `../web/static/agent`,
# which exists on a developer's disk, so the blindness only appears once the images
# are split — and `.dockerignore` excludes that tree from the build context anyway,
# so neither the dev container nor this one ever had it. Production ran this way
# from its first deploy.
#
# ⚠ BUILT HERE, NOT COPIED FROM THE REPO. The committed tree carries every version
# ever built, while the web image serves only what ITS agent stage produced for
# this release. Copying the repo's would advertise versions the web tier answers
# 404 for, and the agent would report DOWNLOAD_FAILED after accepting the update.
# Building from the same source in the same release is what makes the two agree.
#
# Manifests only: the binaries are ~30MB and this tier never serves them.
# ⚠ Keep this tag in step with `go` in agent/go.mod, as apps/web/Dockerfile does.
FROM node:22-alpine AS agent
COPY --from=golang:1.26.5-alpine /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
WORKDIR /src
COPY agent ./agent
COPY tools/build-agent-binaries.mjs ./tools/
RUN node tools/build-agent-binaries.mjs \
 && find apps/web/static/agent -type f ! -name manifest.json -delete

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 101 app && adduser -S -D -H -u 100 -G app app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=manifests /app/apps/api ./apps/api
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
# Named outright rather than left to the fallback: the fallback describes a
# checkout's layout (`../web/static/agent`), and reproducing that path inside an
# image that has no web workspace would be a lie a future reader has to unpick.
COPY --from=agent /src/apps/web/static/agent ./agent-releases
ENV AGENT_RELEASE_DIR=/app/agent-releases
WORKDIR /app/apps/api
USER 100:101
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main"]
