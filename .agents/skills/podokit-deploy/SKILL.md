---
name: podokit-deploy
description: Plan, inspect, apply, verify, and roll back PodoKit releases with an explicit deployment profile and confirmation hash, on Kubernetes or Docker Compose. Use when an agent needs to initialize a .podokit/deploy profile, diagnose a target, preview a release, perform an approved deployment, inspect rollout state, verify public endpoints, or prepare a rollback.
---

# Deploy a PodoKit application

A profile records which driver it uses, so every command below is the same for both.
Read the profile's `driver` first and say which one you are operating.

| Driver | Target | Use it when |
| --- | --- | --- |
| `kubernetes-helm` | a cluster context and namespace | you already run a cluster, or you need more than one node, cluster-managed rollouts, or per-workload scaling |
| `docker-compose` | one Docker host, local or over `ssh://` | one machine is the whole deployment and a reverse proxy in front of it terminates TLS |

1. Run `bunx --bun @podosoft/podokit status`, `bunx --bun @podosoft/podokit diff`, and `bunx --bun @podosoft/podokit doctor`. Stop if managed-file conflicts or unsupported framework versions could make the image unreliable.
2. Read [references/profile.md](references/profile.md) before creating or changing a deployment profile.
3. Make sure the images exist for that tag. Read [references/release.md](references/release.md): tagging `vX.Y.Z` runs the release workflow, which builds and pushes both images and stops there. Never apply a release whose images were not published.
4. Run `bunx --bun @podosoft/podokit deploy doctor --profile <name>`. Resolve every failure without printing secret values.
5. Run `bunx --bun @podosoft/podokit deploy plan --profile <name> --release <stable-semver> --json`.
6. Show the user the driver, the target (context plus namespace and Helm release, or Docker context plus Compose project), the fingerprint result, the exact image digests, the current revision, the actions, the migration warning, and the plan hash.
7. Do not apply until the user explicitly approves that exact plan.
8. Apply with `bunx --bun @podosoft/podokit deploy apply --profile <name> --release <stable-semver> --confirm <plan-hash>`.
9. Run `bunx --bun @podosoft/podokit deploy status --profile <name> --json` and `bunx --bun @podosoft/podokit deploy verify --profile <name> --json`.
10. Report the exact images, the revision, running replicas, restart totals, and the verification result. Report `syncDrift` too: a non-empty value means containers are running locally synced artifacts and the release tag does not describe what is serving.

## Iterating against a deployment is a different command

If the user is changing code and wants to see it on the deployment, a release is the
wrong loop — it rebuilds and republishes to move a few megabytes of compiled output.
Use the `podokit-deploy-fast` skill (`podo deploy sync`, docker-compose driver only).
Reach for a release when the change needs a migration, changes runtime dependencies,
or is going to real users.

## The migration runs against the release that is still serving

Both drivers run the migration **before** the new containers start, and both keep the
previous release serving while the new one rolls out. So a migration must be
compatible with the code already running:

- Additive changes are safe: new tables, new nullable columns, new indexes.
- Dropping or renaming a column, or tightening a constraint, breaks the running
  release the moment the migration commits — before any new code is live.
- Destructive changes belong in a **second** release, after the code that stopped
  using the column has fully rolled out.

Rollback does not reverse migrations on either driver. If an older image cannot read
the current schema, roll forward instead.

## Rollback

Read [references/rollback.md](references/rollback.md), preview the target revision
without `--confirm`, show the new plan hash, and obtain explicit approval.

The compose driver can only reproduce a revision whose rendered project still matches
the current profile byte for byte; if the profile changed since, it refuses and tells
you to roll forward.

## Boundary

Never create or rotate cluster credentials, registry credentials, DNS records,
virtual machines, Kubernetes Secrets, env files on a deployment host, TLS
certificates, or backup repositories. Never put a password, token, private key,
connection URL containing credentials, or secret value in a profile, a command
argument, a log, or a report.
