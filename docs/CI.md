# CI and release workflows

What each GitHub Actions workflow proves, where its time goes, and the rules that keep it fast.
**A workflow or step that takes about ten minutes or more is a defect to measure and fix, not a wait
to accept** — but a speed-up must never drop something the release proves.

## 1. Workflows

| Workflow | Trigger | Runners | What it proves |
|---|---|---|---|
| `ci.yml` | push to `main`, every pull request (superseded runs cancelled) | `ubuntu-latest`, `ubuntu-24.04-arm` | build, lint, unit tests, migrations, database recovery, native migration images, agent version bump, reproducible agent binaries against the committed `SHA256SUMS` |
| `readiness.yml` | pull request, manual | `ubuntu-24.04` | the production runtime with a real agent on SQLite and PostgreSQL |
| `desktop.yml` | pull request touching desktop inputs, manual, called by `release.yml` | one shared agent job, four native installer runners, four clean verification runners | installers for macOS Intel and Apple Silicon, Windows x64, Linux x64, verified on fresh machines |
| `release.yml` | `vX.Y.Z` tag, manual rebuild of an existing tag | Linux amd64 and arm64, plus `desktop.yml` | verified multi-architecture images, signed installers, agent binaries, checksums, the GitHub release |
| `macos-update-probe.yml` | pull request touching the probe, manual | `macos-26` | self-signed update and relaunch between two disposable app versions |

All jobs use GitHub-hosted standard runners. They are free and unmetered for a public repository,
so the cost that matters is wall time and the plan's concurrent-job limit, which is smaller for macOS.
Do not move these workflows to self-hosted runners: on a public repository a pull request from a
fork would run its code on that machine.

## 2. Measurements before the October 2026 speed-up

Durations are minutes from run creation to completion, from successful runs up to 2026-10-16.
Queue time was under 0.3 minutes for every job, so the time is spent running, not waiting.

| Workflow | Median | Range | Sample |
|---|---:|---:|---|
| `release.yml` | 12.5 | 11.6–14.4 | v0.12.3 to v0.15.0 (5 runs) |
| `desktop.yml` (pull request, manual) | 10.6 | 5.5–24.1 | 12 runs; 19.4 and 24.1 include a re-run of a failed macOS Intel job |
| `macos-package-probe.yml` (removed) | 8.3 | 6.1–9.9 | 9 runs |
| `ci.yml` | 2.9 | up to 4.8 | 60 runs |
| `readiness.yml` | 2.8 | | |

The release's critical path was verify, then the macOS Intel installer, then its clean-runner
verification, then publish (run 38870969328, minutes after creation: verify 0.1–1.3, macOS Intel
package 1.4–7.5, macOS Intel verification 7.6–10.7, publish 10.7–12.5). The image builds finished
by minute 8 and were never the long pole. Medians over the five releases:

| Job | Minutes | Largest steps |
|---|---:|---|
| macOS Intel package | 6.1 | services and host agent 2.1, of which the four agent cross-compiles took 1.2 with no Go cache; signed packaging 2.0; Go toolchain download 0.6; artifact upload 0.3 |
| macOS Intel verification | 2.9 | DMG and ZIP verification with two runtime launches 1.6; `bun ci` 0.4; download 0.3 |
| publish | 1.8 | a second agent build without a Go cache 0.8; release upload 0.3 |
| verify | 1.1 | lint 0.4; unit tests 0.2. Installers waited for it although only publish uses its result |
| image builds | 5.7 (amd64), 4.9 (arm64) | API image 3.1 and web image 2.0 on amd64 |

In pull-request `desktop.yml` runs the macOS Intel package job had a median of 7.4 minutes
(services and host agent 2.5, packaging 2.4, Go setup 0.8). Every installer runner installed Go and
cross-compiled the same four agent binaries.

Both macOS Intel re-runs were flakes on that slow runner, and each re-run added 9 to 13 minutes. One
was a unit test that compiles a full TypeScript program: it takes 1.3–3.1 seconds there and once took
5.3, past `bun test`'s 5-second default. The other was `dmgbuild` failing to detach its disk image
("Resource busy").

`macos-package-probe.yml` ran the same `--ci-probe` packaging and `--runtime` verification as the
macOS legs of `desktop.yml`. Its path filter was a subset of `desktop.yml`'s, so it always ran beside
it on the same commit and added four macOS jobs (about 14 runner minutes) to each such pull request.

## 3. Changes

1. **The agent is built once.** The `agent` job of `desktop.yml` runs `bun run build:agent` on Linux
   with the same `actions/setup-go` version and inputs as the `ci` agent job, so it restores the Go
   cache that `ci` saves on `main`. It hands the result to every installer runner as an
   `agent-binaries` tar archive, which keeps the executables' file modes. Installer runners no longer
   install Go.
2. **The release attaches those bytes.** `publish` restores the same archive, checks it with
   `sha256sum -c SHA256SUMS`, and keeps comparing it with the binaries inside both web images. It no
   longer installs Go or builds the agent a second time.
3. **Installers start beside verify.** In `release.yml` the `desktop` job no longer needs `verify`.
   `publish` still needs `verify`, `build` and `desktop`, so nothing is published unverified, and the
   signing step still refuses any ref that is not the running `vX.Y.Z` tag.
4. **The duplicate macOS probe is gone.** `macos-package-probe.yml` was removed. Run `desktop.yml` by
   hand with `signed` off for the same check on a branch.
5. **Installer artifacts are uploaded without compression.** DMG, ZIP, NSIS, AppImage, Debian
   packages and blockmaps are already compressed, so `compression-level: 0` only saves time.
6. **Superseded pull-request runs of `desktop.yml` are cancelled.** A release calls the workflow from
   a tag, and every event other than `pull_request` gets a group of its own, so a release is never
   cancelled.
7. **The TypeScript-compiling desktop test has a 30-second timeout.** The `dmgbuild` detach failure
   is not addressed; re-run the failed job when it happens.

What the release proves is unchanged: the same 22 assets (four agent binaries, `SHA256SUMS`,
`manifest.json`, 15 desktop files and `DESKTOP-SHA256SUMS`), stable-identity macOS signing on the
tag, clean-runner verification of every installer against the committed agent `SHA256SUMS`, both
image digests joined into one tag, and agent bytes identical across both images and the release
assets. One link is stronger: the release assets are now the exact bytes the installers embed.

## 4. Effect

| Workflow | Before (median) | After (measured) | Notes |
|---|---:|---:|---|
| `release.yml` | 12.5 | 9.2 | critical path: agent 0.3, macOS Intel package 4.9, its verification 2.7, publish 0.9 |
| `desktop.yml` (pull request, manual) | 10.6 (10.9 on the same day) | 8.2 | critical path: agent 0.3, macOS Intel package 5.5, its verification 2.0 |
| `macos-package-probe.yml` | 8.3 | removed | the same checks run in `desktop.yml` |

`desktop.yml` was measured on 2026-10-16 with manual unsigned runs started one after the other on the
same day: the `ci-speed` branch took 8.2 minutes (run 38899116172: agent 0.3, macOS Intel package 5.5,
Windows 3.5, Linux 2.9, Apple Silicon 1.9, verification 1.1–2.2), and `main` before the change took
10.9 minutes (run 38900062507: macOS Intel package 7.3, Windows 4.9, Apple Silicon 3.9, Linux 3.8,
verification 1.2–3.2).

`release.yml` was measured on the first tagged release after the change, v0.16.0 on 2026-10-16
(run 38905079032), at 9.2 minutes against the 12.5-minute median before it. Durations and finishing
times are in minutes, the latter counted from the run's creation:

| Job | Minutes | Finished at |
|---|---:|---:|
| verify | 1.5 | 1.6 |
| desktop agent | 0.3 | 0.4 |
| installers: macOS Intel, Linux, Windows, Apple Silicon | 4.9, 3.4, 3.2, 2.2 | 5.4 |
| image builds: amd64, arm64 | 6.3, 4.4 | 8.0 |
| clean-runner verification: macOS Intel, Windows, Apple Silicon, Linux | 2.7, 1.9, 1.8, 1.1 | 8.2 |
| publish | 0.9 | 9.2 |

The installers started beside verify, as intended. Every verification job needs the whole installer
matrix, so all four start when the macOS Intel package finishes. The critical path is still that
package, its verification and publish, but the image path (verify, then the amd64 image build) now
finishes at minute 8.0, only 0.2 minutes earlier. Shortening the installers alone no longer makes the
release faster: the next speed-up has to shorten both the macOS Intel path and the amd64 image build.

## 5. Keeping it fast

- **Measure before changing.** `gh run list --workflow <file> --json databaseId,createdAt,updatedAt`
  gives run durations, `gh run view <id> --json jobs` gives job and step start and end times, and
  `gh run view <id> --job <job-id> --log` timestamps every line inside a step. Work on the critical
  path first; shortening a job that finishes early changes nothing.
- **Build platform-independent outputs once** and hand them on as an artifact. Use a tar archive
  when file modes matter, and a relative download path when Windows runners extract it.
- **Reuse cache keys instead of adding new ones.** The repository's Actions cache holds about 7 GB
  of its 10 GB limit, mostly image build layers. A new key family evicts older entries.
- **One workflow per proof.** Do not run the same steps twice on the same commit under two names.
- **Pull-request workflows cancel superseded runs.** A workflow that `release.yml` calls must never
  be cancellable from outside its own run.
- **Keep slow assertions out of unit tests.** A unit test that takes seconds on an idle machine
  passes the 5-second default timeout (Vitest and `bun test` alike) on a loaded runner and fails
  there. In `apps/web/test/backend-proxy-download.test.ts`, a deep `toEqual` over a 1 MiB
  body walked every byte: 2.1 seconds on an idle machine and more than 7 under load. It failed
  `main`'s CI twice (runs 38870025855 and 38870813688) and stopped the first v0.16.0 tag push at the
  local preflight. A length check and `Buffer.equals` take 29 ms and still fail on one changed byte.
  Compare large binary values as bytes, not with a deep equal.
- **Never trade a release proof for time**: signing, clean-runner verification, checksums, image and
  asset equality, the asset list, and the `verify` gate before `publish`.

## Developer ID signing transition

From 0.17.1, `release.yml` calls `agent-binaries.yml` once beside its verify job. That protected macOS
job verifies a reproducible source build, reuses a previously published signed agent release when
available, or signs/notarizes a new agent version. It supplies the same `agent-binaries` archive to
both image architectures and to `desktop.yml` through its optional `agent_artifact` input. Standalone
and PR desktop runs prepare their own artifact; PRs stay unsigned/disposable and receive no Apple
credentials. Docker's `AGENT_ARTIFACTS_BASE` defaults to its reproducible source stage; releases
explicitly select the `pdmux-agent-artifacts` named build context instead.

The committed unsigned hashes remain the source verification gate. Clean installer checks use the
canonical distribution hashes and additionally verify the Darwin certificate, hardened runtime,
secure timestamps and notarization tickets. Both web images, API manifests, all installers and
GitHub downloads must describe identical distribution bytes. The 22-asset release layout and the
publish dependency on every verify/build/desktop gate remain intact.

The 9.2-minute release and 8.2-minute validation measurements above predate notarization. Do not
report them as timings for this path. Record the first protected workflow's per-step durations after
it runs, including agent reuse, Apple submission waits, app notarization and DMG finalization.
Local signing measurements and any unrun native CI checks are recorded separately in the private
workspace operations record.
