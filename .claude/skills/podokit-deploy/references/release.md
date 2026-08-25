# Publishing the images a release deploys

`podo deploy` consumes images. Building them is `.github/workflows/release.yml`,
which triggers on a `v*.*.*` tag, verifies the commit, builds both images for both
architectures, and publishes them under that one tag. It does not roll out.

```bash
git tag v1.2.3
git push origin v1.2.3
```

Then plan and apply as the main skill describes. `podo deploy plan` resolves the tag
to an immutable digest, so a tag whose images were never pushed fails there rather
than half way through a rollout.

## What the workflow does, in three jobs

| Job | Where | What |
| --- | --- | --- |
| `verify` | `ubuntu-latest` | `bun run lint` + `bun run test`, and reads the deployment profile for the image repositories. Runs once — the suites are portable code and the answer does not depend on the machine |
| `build` | `ubuntu-latest` **and** `ubuntu-24.04-arm` | each builds both images NATIVELY for its own architecture and pushes them **by digest, with no tag** |
| `publish` | `ubuntu-latest` | `docker buildx imagetools create` joins the digests into one manifest list per image, then builds the agent binaries and attaches them to the GitHub release |

⚠ **The tag only starts existing in `publish`.** Both architectures push into the same
repository, so a tag written per architecture would have each job overwrite the
other's and the last one to finish would silently decide what the tag means. That is
why `build` uses `push-by-digest=true` and sets `provenance: false` — an attestation
manifest attaches itself to the index, and `imagetools create` over per-architecture
digests would then produce an index whose entries disagree about what they describe.

⚠ **`publish` also checks that both architectures' web images carry byte-identical
agent binaries**, against each other and against the release assets. The agent build
is reproducible on purpose (`-trimpath`, `-buildvcs=false`, a Go version pinned by
`go.mod` and by the Dockerfile's base tag), and an agent verifies its update against a
sha256 the server hands out — so a version whose bytes depended on which architecture
served the request would identify nothing. A mismatch there is a finding, not noise.

## Variables

| Variable | Unset | Notes |
| --- | --- | --- |
| `PODOKIT_DEPLOY_PROFILE` | `production` | which `.podokit/deploy/<name>.json` names the image repositories. This repository sets it to `publish` |

That is the whole list. `PODOKIT_RUNNER` and `PODOKIT_IMAGE_PLATFORM` are **no longer
read by `release.yml`** (`ci.yml` still honours `PODOKIT_RUNNER`):

- The runner labels are literal, because the architecture matrix needs specific ones
  and this repository is public — GitHub-hosted minutes are free here, and a
  self-hosted runner on a public repository is a machine you own running code you did
  not write.
- The platform is no longer a choice; it is both of them. The `exec format error` at
  rollout that `PODOKIT_IMAGE_PLATFORM` existed to prevent cannot happen now.

## Secrets

**None.** The images go to this repository's own package registry and
`secrets.GITHUB_TOKEN` is the credential, which is why the jobs declare
`permissions: packages: write` (and `contents: write`, for attaching the release
assets). `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` stopped existing when this moved — a
registry credential that is not stored cannot leak.

⚠ **A package pushed to ghcr for the first time is PRIVATE even when the repository is
public.** Visibility does not carry across; it is set once, per package, in that
package's own settings, and until then `docker pull` fails with a 401 that reads like
a credential problem on the puller's side.

## Building by hand

Only when a tag is not the right trigger — and note that this produces a
**single-architecture** image, because assembling the manifest list is the workflow's
job:

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t <api-repository>:v1.2.3 .
docker build --platform linux/amd64 -f apps/web/Dockerfile -t <web-repository>:v1.2.3 .
docker push <api-repository>:v1.2.3
docker push <web-repository>:v1.2.3
```

A bare local tag cannot be deployed: it does not match the profile's stable SemVer
pattern and cannot be resolved to a digest.
