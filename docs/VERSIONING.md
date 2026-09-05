# Version rules

pdmux carries **two SemVer lines**, deliberately moving apart, and one **hard gate** on
top of them in the shape of a protocol version. Mixing the three breaks quietly in three
different ways, so this document records what each number promises and the two CI checks
that keep those promises.

---

## 1. The two SemVer lines

| Line | Source of truth | Today | When it moves |
|---|---|---|---|
| **The repository (pdmux itself)** | `version` in the root `package.json` | `0.12.1` | every product release |
| **The agent** | `AgentVersion` in `agent/internal/cli/version.go` | `0.1.24` | only when `agent/**` or `packages/protocol/**` changes |

**Why they are not one number**: the agent is not something we deploy — it is something a
**host downloads**. A host compares its own version against what the server publishes and
decides "I need an update" by itself. If a web-only release moved both numbers, **every
host would put on an amber badge**, and pressing update would re-download a binary that
is **byte-for-byte identical**. That is asking a whole fleet to perform an update that
fixes nothing, and after a few rounds people stop reading the badge.

The opposite direction is just as bad. Fix the agent without moving `AgentVersion` and
that release **reaches nobody** — the host compares versions, finds them equal, and does
not download. So **the version bump is the release**, and the first CI check in §5
enforces it.

`version` in `manifest.json` is **the agent's SemVer**, not the repository's. The build
script reads `version.go` and copies it, so no second source of truth appears.

A running pdmux shows the **repository version** under the account menu and tells agents
about it as `welcome.serverVersion` — **advisory, not a gate**.

---

## 2. `PROTOCOL_VERSION` — the hard gate

`PROTOCOL_VERSION = 1` in `packages/protocol/src/index.ts`. The Go side is not
hand-written; it is **generated** into `agent/internal/protocol/consts_gen.go` (see
[`AGENT_GO.md`](AGENT_GO.md) §3).

This is a statement about **the shape of the wire**, not about the build. The contract is
additive, so adding a field leaves this number alone ([`CONTRACTS.md`](CONTRACTS.md) C0).
Raise it only when something genuinely has to break, and **keep the old reader** — there
are already agents installed on machines that cannot be upgraded today.

When a host's `hello.protocolVersion` differs from the server's, its card shows a red
`incompatible`. **The connection is still not closed.** The one thing you must always be
able to tell an agent that is too old is "update yourself", and hanging up removes your
ability to say it.

---

## 3. `MIN_SUPPORTED_AGENT` — and what the `-0` is doing

```ts
export const MIN_SUPPORTED_AGENT = '0.1.0-0';
```

An agent below this also gets the `incompatible` badge. **The trailing `-0` is not a typo;
it is the entire point of the constant.**

In SemVer a prerelease sorts **below** the release it leads to. An agent compiled from a
checkout reports something like `0.1.0-dev.3+g1a2b3c`, so a flat floor of `0.1.0` puts
every such build underneath it — **every development machine wears a red badge** for the
whole time 0.1.0 is being written. `0.1.0-0` is the lowest possible prerelease of 0.1.0,
so it admits every build of that version and excludes only genuinely older ones.

There is one reason to raise it: **the server has actually stopped understanding that old
agent.** It is a badge and a warning, never a reason to refuse a connection (same
reasoning as §2).

---

## 4. What the card's "Agent" column is saying

The number in the column is `hello.agentVersion`; the badge beside it is a **verdict**
(`agentVersionState`, `packages/protocol/src/semver.ts`).

| Badge | Meaning |
|---|---|
| `current` | matches the newest build published for that host's os/arch |
| `outdated` | something newer is published → a candidate for update |
| `ahead` | newer than what is published (a host with a hand-installed dev build) |
| `unknown` | the version string could not be read, **or nothing is published for that platform** |
| `incompatible` | protocol version mismatch, or below `MIN_SUPPORTED_AGENT` |

The comparison is **per host (os, arch)**. One release, four binaries — so whether a Linux
host is current has to be decided against the Linux build.

`unknown` folding two situations into one is deliberate: both mean "we cannot call this
host behind", and there is no reason to mint a second badge for a distinction the reader
cannot act on differently.

⚠ `hello.agentVersion` is **free-form in the contract**. Tightening it to a SemVer pattern
makes a host that sends `0.1.0-dev+g1a2b3c` fail `safeParse` and **vanish from the
dashboard** — and the update button that would have fixed that host is on the screen that
just disappeared. The strictness lives on the reading side instead (`parseSemver` → null →
`unknown`), so being wrong costs one grey badge.

---

## 5. The two CI checks that keep the manifest honest

`.github/workflows/ci.yml`.

### 5-1. `agent-version` — if it changed, was it bumped?

Runs on pull requests and pushes to `main`. If the base…HEAD
diff touched `agent/**` or `packages/protocol/**` and `AgentVersion` did not move, it
**fails**.

There is an exclusion list: `_test.go`, `testdata/`, `packages/protocol/test/`,
`packages/protocol/conformance/`. The Go toolchain never compiles any of these into a
non-test build, so bumping the version for them publishes a new version whose binary is
**byte-identical to the previous one** — every host re-downloads the same bytes, which is
the same dishonesty pointing the other way.

### 5-2. `agent-binaries` — does it really report the version it promised?

Builds all four with `bun run build:agent`, then:

1. Fails if the built **linux/amd64 binary's `--version`** differs from `version` in
   `manifest.json`.
2. Runs `sha256sum -c SHA256SUMS`, then `diff`s the hash list in `manifest.json` against
   `SHA256SUMS`.
3. Compares the generated checksums and manifest with the committed metadata, ignoring only
   `builtAt`. This prevents a checkout or development build from serving an older binary while
   tagged images quietly rebuild the current source.

The first is not a hypothetical. While `AgentVersion` was a **`const`**, the linker's
`-ldflags -X` **silently did nothing** — `-X` only works on string *variables*. The
manifest promised 1.5.0, the binary reported 1.4.0, and every host stayed "behind" after
updating, so it updated again. Forever. That is why the declaration in `version.go` must
be a **`var`**, and why a comment in that file guards the reason.

The Go toolchain is pinned by `agent/go.mod` (`go-version-file`). The agent stage in
`apps/web/Dockerfile` reads the same file — a different Go patch release produces a
different binary, and the update path compares sha256.

---

## 6. Reproducible builds

`tools/build-agent-binaries.mjs` builds all four targets with `CGO_ENABLED=0`,
`-trimpath` and `-buildvcs=false`.

- `-trimpath` — the build machine's absolute paths would otherwise land in the binary and
  every developer would produce a different result.
- `-buildvcs=false` — this stamps not only the commit id but **the whole repository's dirty
  flag**. With it on, **editing one line of the README changes the agent's sha256** and
  every host re-downloads the same bytes.

Output goes to `apps/web/static/agent/<version>/` and the web image serves it verbatim at
`/agent/<version>/…`. No object store, no second hostname, no credentials — that is why
installation can be one line.

Measured (0.1.1, Go 1.26.5):

| Target | Bytes | |
|---|---|---|
| linux/amd64 | 8,118,434 | 7.74 MiB |
| linux/arm64 | 7,471,266 | 7.12 MiB |
| darwin/amd64 | 8,268,560 | 7.89 MiB |
| darwin/arm64 | 7,668,194 | 7.31 MiB |

The only field in `manifest.json` that differs between two runs is `builtAt`, and that
value is **outside what is hashed** — metadata for a person reading the directory, never
compared against anything.

⚠ `bun run build:agent` is **not part of `bun run build`.** The root build runs on every CI
machine and those machines have no Go toolchain — wiring them together turns a change that
never touched the agent red. It is invoked by the release job, by the Docker builder
stage, or by a person **on purpose**.

---

## 7. Release procedure

1. Bump `AgentVersion` in `agent/internal/cli/version.go` (**required** if the agent or
   the contract was touched).
2. For a product release, update `version` in the root `package.json` and `CHANGELOG.md`.
   The two have **no reason to move together** — if only the web changed, leave the agent
   alone.
3. `bun run build:agent` — four binaries plus `SHA256SUMS` and `manifest.json` under
   `apps/web/static/agent/<version>/`.
4. Deploy. The moment the web image serves that directory, `/install.sh` bakes the new
   version's checksums into what it hands out and the card's `outdated` badge lights up.
5. Roll out **canary first** — a fleet batch update is refused with `NO_CANARY` (409) if
   not one host is already running that version.

⚠ **Do not casually delete an old version directory.** The server enumerates **every
version directory** under the release root (`AGENT_RELEASE_DIR`, or
`apps/web/{build/client,static}/agent` relative to a checkout), and an update request can
name a `version` to pick one of them. A deleted version can no longer be named — which
means the target of a deliberate downgrade (`force`) is gone. What `install.sh` bakes is
always the checksums of **the single newest version**.

### 7-1. ⚠ A container deployment serves exactly one version — all four platforms of it

The paragraph above describes a **checkout**, where every released version accumulates
under `apps/web/static/agent/`. A deployed image does not work that way, and the
difference decides what a running server can be asked for.

`.dockerignore` excludes `apps/web/static/agent` on purpose — a local `bun run build:agent`
leaves ~30 MB there and shipping the developer's copy would only bloat the build context.
Each image instead builds its own in an `agent` stage. So an image contains the **one
version that commit declares** in `agent/internal/cli/version.go`, and nothing else:

| | in a checkout | in a deployed image |
|---|---|---|
| versions present | every released one (`0.1.0` … current) | **the current one only** |
| platforms per version | linux/darwin × amd64/arm64 — **all four** | **all four**, unchanged |
| what the web image carries | — | the four binaries, `SHA256SUMS`, `manifest.json` (~31 MB) |
| what the api image carries | — | `manifest.json` only; the binaries are deleted after the build |

**Platforms are not the axis that narrows.** A host installing or updating gets its own
`GOOS/GOARCH` from the same four artifacts regardless of the server's architecture — the
agent is cross-compiled and the release job verifies that the amd64 and arm64 images carry
byte-identical binaries. Only the **version** axis collapses to one.

The consequence, and it is the only one: **a deliberate downgrade cannot name a version the
running image was not built from.** `force` to `0.1.6` from a server built at `0.1.7`
answers 404, because that directory never existed in the image. Normal paths are unaffected
— `install.sh` bakes the newest, and an update always moves toward the newest.

To go back, roll the *deployment* back to the release whose image carried the version you
want, rather than expecting one image to hold several. That is the same rule as everything
else here: the image is the unit, and a version is a property of it.
