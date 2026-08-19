# The host agent (Go)

The agent is a single Go module under `agent/`, and what it produces is **one static
binary**. The target machine needs no language runtime, no compiler and no package
manager — that is the only reason installation can be one line of `curl … | sh`, and
every decision in this document leans towards protecting that property.

The code is authoritative. This document records **what lives where, and what is
hand-written versus generated**.

---

## 1. The module

```
module github.com/podosoft-dev/pdmux/agent
go 1.26.5
```

Four dependencies, and that is all:

| Module | Used for |
|---|---|
| `github.com/coder/websocket` | the single outbound socket to the server |
| `github.com/creack/pty` | a real PTY. Why the `script(1)` fallback and its limits (§5) are gone |
| `github.com/santhosh-tekuri/jsonschema/v6` | validating frames against the embedded contract |
| `golang.org/x/text` | UTF-8 boundary handling for terminal output |

Built with **`CGO_ENABLED=0`**. Turning cgo on links against the build machine's libc, and
at that moment the promise of "no assumptions about the target" is broken.

Builds, versions and reproducibility live in [`VERSIONING.md`](VERSIONING.md).

---

## 2. Layout

```
agent/
├── cmd/pdmux-agent/        wiring only — main.go (signals, dependencies), daemon.go (the CLI↔runtime seam)
└── internal/
    ├── cli/                the command surface: run · install · doctor · verify, argument parsing, exit codes
    ├── config/             resolving configuration — flags > environment > file
    ├── agent/              the daemon: one connection, two timers, whatever the server asks for
    ├── net/                outbound WebSocket client with jittered backoff
    ├── protocol/           the Go side of the contract — structs, validation, defaults (some generated, §3)
    ├── semver/             a replica of what `packages/protocol/src/semver.ts` does
    ├── collect/            heartbeat: CPU/memory/swap/disk · sessions · service probes · diagnostics
    ├── usage/              coding-CLI usage — the provider plugin seam
    ├── git/                read-only snapshots · commits · diffs · the detail ledger
    ├── term/               PTY ownership · target resolution · output coalescing and caps
    ├── update/             remote update: verify→commit, the probation marker, self-refusal
    ├── state/              resolving the state directory (system=/var/lib, user=~/.local/state)
    ├── log/                one-line structured logging + **secret masking**
    └── sys/                running child processes — a timeout is a required argument, not an option
```

A few of these placements are worth keeping the reason for.

- **`cmd/` holds no decisions.** Every judgement lives in `internal/cli`, so there is
  nothing to mock. And the daemon is started from exactly one place, `daemon.go`, so a CLI
  spec cannot accidentally start a daemon.
- **`update` runs before the dial.** `daemon.go` constructs the engine and calls
  `Startup()` to read the probation marker first — because the entire value of that marker
  is a **judgement on the host's own clock, with the server not involved**. A build that
  panics at start-up or is refused forever has nobody to report to.
- **`log` owns masking.** Tokens appear in the connection URL, the configuration file, the
  installer's output and reconnect messages. A rule that says "do not log the token" is one
  format string away from leaving a live credential in journald for weeks. Register it once
  and callers have nothing to remember.
- **In `sys`, a timeout is a required argument.** Collectors run on **a machine somebody is
  working on**. A hung `tmux` or a repository on a stalled NFS mount may cost that pass one
  result; it must never hold up the whole loop.

---

## 3. Generated versus hand-written

**The contract's source of truth is TypeScript** — the zod in
`packages/protocol/src/index.ts`. Go cannot run zod, so it uses structs, but they **must
not become a second opinion.** Disagreement throws nothing: one field becomes `0` instead
of `null`, and a host that failed to measure reads as "fine, idle" on its card. Silence is
the failure mode, so the checking has to be mechanical.

| File | Owner | Contents |
|---|---|---|
| `internal/protocol/types.go` | **hand** | frame structs. No `omitempty` (except the two genuinely optional fields) |
| `internal/protocol/validate.go` | **hand** | validation against the embedded schema. Inbound failure = discard (not fatal); outbound is validated too (terminal frames exempt) |
| `internal/protocol/envelope.go` | **hand** | envelope discrimination and encoding |
| `internal/protocol/gen/main.go` | **hand** | the generator that produces the three below |
| `internal/protocol/schema/protocol.schema.json` | **generated** | zod→JSON Schema, mirrored into this package for `go:embed` |
| `internal/protocol/consts_gen.go` | **generated** | constants the schema cannot express (`x-api-key`, `/agent/ws`, `PROTOCOL_VERSION`, `MIN_SUPPORTED_AGENT`, diff caps) |
| `internal/protocol/defaults_gen.go` | **generated** | a seeder that fills the contract's defaults **recursively**, plus `UnmarshalJSON` |
| `internal/protocol/schema_hash.go` | **generated** | a sha256 pin of `packages/protocol/schema/*.json` |

Generated files start with `// Code generated by internal/protocol/gen. DO NOT EDIT.`

**Why mirror instead of using a relative path**: the agent runs on somebody else's machine.
There is no `packages/protocol` there. The conformance corpus is the opposite case — it is
**test-only data**, so it is not copied and the tests read it relatively.

**Why the defaults are not hand-written**: zod fills a default into every key that arrives
`undefined`, and there are about ninety such keys. Transcribing them is not hard; **keeping
them correct** is, and being wrong is silent — reading a missing `heartbeatSec` as 0 does
not fail, it **polls in a hot loop**. The generator exists to avoid three traps:

1. **A `.default({})` on an object appears in the schema as a literal `{}`.** The nested
   defaults are not visible there, and worse, that `default` is a sibling of a `$ref`, which
   JSON Schema validators are **specified to ignore**. Copying the literal leaves
   `agentHello.update` at its zero value, so `restartMode` becomes `""` instead of zod's
   `"none"`. Defaults are therefore applied **recursively, following the type**.
2. **Defaults have to reach slice elements.** The default for `uncommitted.files[].x` is
   **a single space**, and no amount of pre-filling the top level reaches it. The generated
   `UnmarshalJSON` seeds the receiver and then unmarshals over it, so `encoding/json` calls
   the same method for every element at every depth.
3. **A new zod object must not slip through.** Every `$def` has to be classified and to
   correspond to something in Go. A `$def` with nowhere to go is **exit 1** — the
   alternative is an agent that silently ignores a new field.

`schema_hash.go` catches the opposite trap. If somebody edits the zod and rebuilds the JSON
artifacts but does not run `go generate`, the agent **validates against a stale contract**
and diverges from the server on fields neither one mentions. A Go test compares the hash and
fails right there.

---

## 4. The `go generate` procedure

Only needed when the contract changed. The order is the dependency direction.

```bash
# 1. edit the source of truth
$EDITOR packages/protocol/src/index.ts

# 2. zod → JSON artifacts (schema/protocol.schema.json, schema/constants.json)
#    This one reads src/ directly — see "Load the contract from SOURCE" in build-schema.mjs.
npm run schema:build -w @pdmux/protocol

# 3. ⚠ NOT OPTIONAL, AND ITS ABSENCE FAILS SILENTLY. Step 4 imports the package's
#    dist/ (build-expected.mjs), NOT src/. Skip this and the expectations are
#    recomputed against the PREVIOUS contract, then `expect:check` agrees with them
#    and the corpus quietly stops covering whatever you just added.
npm run build -w @pdmux/protocol

# 4. recompute the conformance expectations with zod (cases/ is human-owned, expected/ is script-owned)
npm run expect:build -w @pdmux/protocol

# 5. add the new fields to Resource/… in agent/internal/protocol/types.go BY HAND.
#    That file is a port, not generated output; the generator only VALIDATES it and
#    stops with "resource.swapPct has no Go field (add one to Resource)".
$EDITOR agent/internal/protocol/types.go

# 6. JSON artifacts → Go (mirror + consts_gen + defaults_gen + schema_hash)
cd agent && go generate ./...

# 7. is a re-run a no-op — i.e. do the committed artifacts match the contract?
git diff --exit-code

# 8. verify both sides
go test ./...
cd .. && npm test -w @pdmux/protocol
```

Drift is caught by `npm run schema:check -w @pdmux/protocol` / `expect:check` (comparing
generated bytes against committed bytes **byte for byte**) and by the Go-side hash pin
test.

⚠ **THIS PARAGRAPH USED TO SAY "IN CI", AND THAT WAS NOT TRUE.** No workflow called
either check, so for as long as it stood the corpus could go stale exactly the way this
section warns about — and it did: the frame-type list had not been rebuilt since
`fsPut`/`fsDelete`/`fsGet` were added, and it surfaced only when an unrelated change ran
`expect:build` and produced a diff bigger than the change. Both now run in
`tools/preflight.sh`, which the `pre-push` hook calls. The Go half **is** in CI, because
`schema_hash.go` is pinned and a Go test compares it. Adding the two to the workflow is
still worth doing — a hook is per clone and `--no-verify` skips it.

Which means **the output has to be deterministic** — keys sorted, a trailing
newline, and **nothing derived from the clock, a path or the environment**. One
`generatedAt` stamp makes the check fail every time, and then everybody ignores the check.

⚠ `schema:build` must keep `additionalProperties: true` on **every object**. Every object in
the protocol uses zod's default `strip`, and silently ignoring unknown fields is what lets a
new server keep talking to an old agent (`TC-PDPROTO-007`). `zod-to-json-schema` emits the
opposite (`false`) by default, so rather than trusting one option, every object is
re-checked after generation.

### The conformance corpus

`packages/protocol/conformance/` — both languages read **the same files**.

```
cases/*.json      hand-written input frames (human-owned)
expected/*.json   the normalised result zod produces (script-owned — do not edit)
semver.json       parseSemver / compareSemver / the version-state table
```

Four files: direction (upstream/downstream) × verdict (accept/reject). The Go side reads
them from `internal/protocol/conformance_test.go` and `internal/semver/semver_test.go`. **A
missing or empty table fails the test** — a quiet skip defeats precisely the purpose of this
machinery.

---

## 5. The PTY

`creack/pty` opens **a real pty**. The two-branch arrangement from the TypeScript era
(native if `node-pty` was present, otherwise a `script(1)` fallback) and that fallback's
limitation — **resize pinned to the size at open time on macOS, which has no `/proc`** — are
gone. The `pty` line in `doctor` says so directly:

```
PASS  pty           native pty (github.com/creack/pty; resize works on Linux and macOS)
```

The properties that remain are unchanged: closing a terminal terminates the **whole process
group** (an interactive shell ignores SIGTERM, so killing only the wrapper leaves the shell
as a ghost), what dies for a `session` target is only the tmux **client**, and runaway
output drops **the oldest bytes at the buffer cap and reports how many via `output.dropped`**.

---

## 6. The command surface

The argument parser is **hand-written**. Four commands and seven flags do not need a
framework, and a framework starts silently accepting exactly what this agent must refuse. An
unknown argument is **exit 2 plus the help text** — a typo in a systemd unit (`--sever`) must
not become "a daemon that dials nowhere and does not say why".

| Command | What it does |
|---|---|
| `run` | connect and keep reporting (foreground — a service manager supervises it) |
| `install` | write a 0600 config and a service unit, print the activation command. With `--code`, **exchange** it first |
| `doctor` | check configuration, tools, PTY and **a real handshake** |
| `verify` | dial, exit 0 if `welcome` arrives. **Gate 1 of remote update** |

`verify` is new in the Go version. It is the same probe as `doctor`'s connection check, but
remote update has to ask **a candidate binary** "can you actually reach the server?", and a
check that exists only inside a seven-line report cannot be called from a script.

Exit codes are a contract: `0` done · `1` failed · `2` argument refused · `3` enrollment code
refused · `4` host disabled · `5` rate-limited.

`install` **does not call `systemctl`/`launchctl` itself.** Activating a unit needs privileges
the installer may not have, and **a half-finished install that has already declared success**
is worse than printing two lines to paste.

---

## 7. Tests

```bash
cd agent
go test ./...                    # everything
go test ./internal/update/...    # only the package you changed (the recommended loop)
go vet ./...
```

The engine specs in `internal/update` drive every path over a temporary directory in
milliseconds using **an injected clock, exit and verify function** — so swaps, markers and
rollback are verified without replacing a real binary. `install`'s planning stage is pure for
the same reason (it lets the 0600 mode and the unit paths be asserted without a root-owned
`/etc`).
