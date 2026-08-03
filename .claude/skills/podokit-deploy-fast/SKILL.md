---
name: podokit-deploy-fast
description: Push locally built artifacts into a running Docker Compose deployment and restart it, without building or publishing an image. Use when iterating on code against a deployed environment and a full release round trip is too slow. Not for releases, migrations, dependency changes, or anything going to real users.
---

# Sync code into a running deployment

`podo deploy sync` copies this project's build output into the containers that are
already running and restarts them. `docker-compose` driver only — read the profile's
`driver` first and stop if it is `kubernetes-helm`, where the equivalent would have
to reach every node and would stop being a shortcut.

```bash
npx @podosoft/podokit deploy sync --profile <name> --build
```

## Say what this does before doing it

It is not a release, and the user has to understand three consequences before you run
it:

1. **The deployment will run code its image tag does not describe.** A marker file
   records the sync and `podo deploy status` reports it under `syncDrift`.
2. **Every connection the restarted containers hold is dropped** — WebSocket sessions,
   in-flight requests, anything attached.
3. **It disappears on the next release.** Container writable layers do not survive
   recreation, so `podo deploy apply` restores the image with no cleanup step. That is
   the property that makes this safe; do not build anything that depends on the copy
   persisting.

## When NOT to use it

Use a release instead — build the images and `podo deploy apply` — when any of these
is true. The first three are refusals the command makes itself; the last two it
cannot detect, which is why they are your job.

| Situation | Why |
| --- | --- |
| runtime dependencies changed | the container's `node_modules` was installed `--omit=dev` from the old manifest, so the new code imports something that is not there |
| a release holds the deployment lock | an apply is in progress |
| nothing is running for that project | there is no container to copy into |
| **the change needs a migration** | sync never migrates, and a migration belongs with the release whose code needs it |
| **the change is going to real users** | nothing is pushed, so nothing is reproducible from it |

## Procedure

1. Read the profile's `driver`. Stop unless it is `docker-compose`.
2. Tell the user what will restart and that connections drop. Get agreement if anyone
   is using the deployment.
3. Run with `--build` unless the project is already built. `--build` compiles in the
   order the images do — every `packages/*` before the apps — because a root build
   script runs workspaces in manifest order and an app listed first would compile
   against a workspace package's previous output.
4. Report what was copied, which containers restarted, and that the deployment is now
   in sync drift.
5. Verify against the running deployment, not against the build: request a path the
   change affects. If part of the build output is excluded (below), check one of
   those paths too — that is the failure this exclusion exists to prevent, and it
   does not make the page look broken.

## Restoring the image

```bash
npx @podosoft/podokit deploy sync --profile <name> --revert
```

This recreates the containers from the Compose project **already on the target**,
which is the description of what was actually applied — not a fresh render, which
would reproduce the profile as it is now.

A release does the same thing as a side effect, so `--revert` is for abandoning a
sync, not a required cleanup step.

## Excluding part of the build output

Some of a build output can come from a toolchain the developer's machine does not
have. Overwriting that part replaces real artifacts with an index of artifacts that
are no longer there, and the application keeps serving pages while the missing files
404 — so nothing looks broken. Those paths belong in the profile:

```json
{ "sync": { "exclude": ["apps/web/build/static-assets/generated"] } }
```

If you find yourself about to sync over something this machine cannot rebuild, add it
here rather than remembering not to. `--clean` refuses while an exclude sits beneath
a synced path, for the same reason.

## Boundary

Never use this to ship. Never run migrations alongside it. Never create or rotate
credentials, and never print a secret value.
