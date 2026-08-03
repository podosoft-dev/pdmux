# syntax=docker/dockerfile:1

# The npm that reads package-lock.json must be the major that wrote it. node:22
# bundles npm 10, and a lockfile written by npm 11 records platform-specific
# packages as extraneous with no `optional` flag; npm 10 rejects those with
# EBADPLATFORM instead of skipping them, so `npm ci` fails inside the image while
# `npm install` on this machine is fine. Keep this in step with the npm we develop with.
ARG NPM_VERSION=11.17.0

# Every workspace manifest, collected rather than listed.
#
# Listing them by hand is what broke this image before: npm does NOT fail when a
# workspace's package.json is absent, it silently installs a tree without that
# package's dependencies. `@pdmux/protocol` then compiled against the hoisted zod 4
# instead of the zod 3 it declares and died on `.default({})` overloads — silent, and
# only inside the image. Collecting them keeps `npm ci` correct however the workspace
# list changes, and the stages below still cache on the manifests' content.
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

# The runtime tree for this image only. Scoping to the one workspace matters:
# --omit=dev at the root installs the union of every workspace's production
# dependencies, so the web image would carry Nest.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=manifests /app ./
ARG NPM_VERSION
RUN npm i -g "npm@${NPM_VERSION}"
RUN npm ci --omit=dev --no-audit --no-fund --workspace=apps/web --include-workspace-root

# The host agent's four static binaries, built from source in the same image that
# serves them. They are downloaded by the public installer from this origin, so the
# web image is what has to carry them — there is no object store in this product.
#
# Go comes out of the official image instead of `apk add go`: the toolchain is then
# pinned by a tag (a different Go patch produces a different binary, and the update
# path compares sha256), and Node stays exactly the 22 every other stage uses.
# ⚠ Keep this tag in step with `go` in agent/go.mod.
FROM node:22-alpine AS agent
COPY --from=golang:1.26.5-alpine /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
WORKDIR /src
# Only what the build reads. The Go module is self-contained (the protocol schema it
# embeds lives inside agent/), so the rest of the repo cannot invalidate this layer.
COPY agent ./agent
COPY tools/build-agent-binaries.mjs ./tools/
RUN node tools/build-agent-binaries.mjs

FROM node:22-alpine AS build
WORKDIR /app
# Everything `npm ci` produced, not just the root `node_modules`: npm nests a
# dependency it cannot hoist, and `packages/protocol/node_modules/zod` (v3, beside a
# hoisted v4) is exactly that case. Copying only the root directory left protocol
# compiling against the wrong major.
COPY --from=deps /app ./
COPY . .
# ⚠ ORDERING IS LOAD-BEARING, AND ITS FAILURE IS SILENT. Vite copies `static/` into
# `build/client/` as part of the web build, and the runtime stage below ships only
# `apps/web/build` — so binaries that arrive after this line are in no image at all,
# and the installer answers 404 for every download while the page itself looks fine.
# It also has to come after `COPY . .`, which would otherwise overwrite them.
COPY --from=agent /src/apps/web/static/agent ./apps/web/static/agent
# The web app imports `@pdmux/*` by their published entry points (`dist/index.js`),
# and `.dockerignore` excludes `**/dist` — so nothing here has compiled output until
# it is compiled here. Without this the build dies on "Cannot find module
# @pdmux/protocol", which is why the image had never been buildable; `npm run dev`
# and the CI `verify` job both build the packages first, and this is that step.
RUN if [ -d packages ]; then \
      for manifest in packages/*/package.json; do \
        [ -e "$manifest" ] || continue; \
        npm run build --if-present --workspace "$(dirname "$manifest")"; \
      done; \
    fi
RUN npm run build --workspace=apps/web
# The runtime needs the real `packages/*` directories, not just the symlinks npm
# leaves in node_modules pointing at them. Without this the image boots and dies on
# "Cannot find module @pdmux/protocol" — a dangling link, and only at runtime.
RUN mkdir -p /app/packages

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 101 app && adduser -S -D -H -u 100 -G app app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=manifests /app/apps/web ./apps/web
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/build ./apps/web/build
# The entry and its modules run OUTSIDE the bundle, so they ship as source.
COPY --from=build /app/apps/web/server.js ./apps/web/server.js
COPY --from=build /app/apps/web/src/lib/server ./apps/web/src/lib/server
WORKDIR /app/apps/web
USER 100:101
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Not `node build`: the adapter's own entry cannot answer a WebSocket upgrade, so the
# terminal relay would be dead in the image. `server.js` is that entry plus the
# /terminal/ws and /agent/ws proxies (see docs/ARCHITECTURE.md §3).
CMD ["node", "server.js"]
