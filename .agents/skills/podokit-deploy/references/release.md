# Publishing the images a release deploys

`podo deploy` consumes images. Building them is `.github/workflows/release.yml`,
which triggers on a `v*.*.*` tag, verifies the commit, builds both images from the
repository root, and pushes them under that one tag. It does not roll out.

```bash
git tag v1.2.3
git push origin v1.2.3
```

Then plan and apply as the main skill describes. `podo deploy plan` resolves the tag
to an immutable digest, so a tag whose images were never pushed fails there rather
than half way through a rollout.

## Before the first tag: check the runner

**GitHub-hosted runners are free for public repositories only.** In a private
repository every minute is metered against the account's included Actions minutes and
billed beyond them, and image builds are usually the most expensive job a project
runs. A self-hosted runner consumes no Actions minutes at all.

The workflow reads the choice from a variable, so it is a setting rather than an edit:

| Variable | Unset | Notes |
| --- | --- | --- |
| `PODOKIT_RUNNER` | `["ubuntu-latest"]` | JSON array of labels. Self-hosted example: `["self-hosted","Linux","X64"]` |
| `PODOKIT_DEPLOY_PROFILE` | `production` | which `.podokit/deploy/<name>.json` names the image repositories |
| `PODOKIT_IMAGE_PLATFORM` | `linux/amd64` | the architecture the **deployment target** runs, not the runner's |

Nothing warns when a private repository is still on the default: the workflow
succeeds either way and the difference appears on a bill. **When asked to set up
releases, check the repository's visibility first and say which case it is.**

`PODOKIT_IMAGE_PLATFORM` is the other one worth stating out loud. Building for the
wrong architecture produces `exec format error` at rollout — after the migration has
already run — and building for the right one on a runner of a different architecture
works but runs under emulation, which is slow enough to be mistaken for a problem
with Docker.

## Secrets

`REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, for the registry named by the profile's
`release.apiRepository`. A robot or deploy account is enough for pushing, but some
registries do not let a robot **create** a repository — push the first tag of a new
repository with an account that can, or create the repository in the registry first.

Never print either value, and never put one in a profile, a command argument, or a
report.

## Building by hand

Only when a tag is not the right trigger. Build for the target's architecture, tag
both images identically, and push before planning:

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t <api-repository>:v1.2.3 .
docker build --platform linux/amd64 -f apps/web/Dockerfile -t <web-repository>:v1.2.3 .
docker push <api-repository>:v1.2.3
docker push <web-repository>:v1.2.3
```

A bare local tag cannot be deployed: it does not match the profile's stable SemVer
pattern and cannot be resolved to a digest.
