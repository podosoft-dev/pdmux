# The conformance corpus

Data that proves **two languages read the same frame and produce the same value**. The host agent is
written in Go, but the zod schema in `packages/protocol/src/index.ts` remains the source of truth —
Go cannot run zod, so its structs are written by hand and its defaults are filled by hand. When the
two diverge, **nothing throws**: one field becomes `0` instead of `null`, and a host that failed to
measure reads as "fine, idle" on its card.

This corpus is the device that breaks that silence. The frames are data, and both languages read the
same files.

## Directories

```
conformance/
├── cases/*.json      # hand-written input frames (human-owned)
├── expected/*.json   # the normalised result zod produces (script-owned — do not edit)
├── semver.json       # the parseSemver / compareSemver tables (hand-written expectations)
└── README.md
```

`expected/<file>.json` has **the same name** as `cases/<file>.json`. The Go tests open the same pairs.

### Why four files rather than one per case

`upstream-accept` · `upstream-reject` · `downstream-accept` · `downstream-reject` — the four
combinations of **direction × verdict**. A file per case would be 35 files, and answering "what does
the Go port get wrong upstream?" would mean scanning a directory. Grouped this way, that one question
is one file, and because cases are identified by `id` the Go loader does not care about file
boundaries. If a file grows long as cases accumulate, split it further by topic while keeping the same
axes (direction × verdict).

## Case format

```json
{
  "id": "hello-capabilities-null",
  "direction": "upstream",
  "expect": "reject",
  "why": "A nil Go slice marshals to null …",
  "frame": { "type": "hello", "hello": { "…": "…" } }
}
```

| Field | Meaning |
|---|---|
| `id` | a stable identifier, **unique across the whole corpus**. It is the key in `expected/` and the name in a failure message, so renaming it means moving the expectation too. |
| `direction` | `upstream` = agent→server (`agentUpstreamSchema`), `downstream` = server→agent (`agentDownstreamSchema`). This value decides which schema parses it. |
| `expect` | `accept` or `reject`. |
| `why` | **one line** on what decision this case pins down. This is the evidence when somebody proposes deleting the case. |
| `frame` | the **complete envelope frame** to validate. Sub-objects are never validated alone — only the shape parsed at the real boundary proves anything about that boundary. |

The top level of each file has a `description` (what that group protects) and a `cases` array. The
JSON is **pure data with no comments** (Go reads it with `encoding/json`).

## Expectation format (`expected/`)

```json
{
  "generatedBy": "packages/protocol/scripts/build-expected.mjs",
  "cases": "conformance/cases/upstream-accept.json",
  "protocolVersion": 1,
  "accepted": { "<id>": { "…the normalised frame…" } },
  "rejected": { "<id>": "hello.capabilities: Expected array, received null" }
}
```

- **`accepted` is the contract.** A second implementation must produce this value from the same
  input. Object keys are **sorted recursively** — neither the schema's field declaration order nor
  the Go struct's field order is part of the contract, so reordering them does not disturb this file.
  Array order is data and is preserved. Comparison is **by value after deserialisation** (never byte
  comparison).
- **`rejected` is informational.** These are zod diagnostic strings and not a contract — Go asserts
  only "it was rejected" and never the wording. It is stored alongside so a person can read the cause.

### Why the expectations are not hand-written

A hand-written expectation only proves "the author and the author's schema agree with each other".
Change a `.default()` and the expectation changes in the same commit, and the corpus quietly stops
checking anything. Generated, the opposite holds: **the diff from `npm run expect:build` is the
behaviour change**, and it turns up in review.

Conversely, **the inputs (`cases/`) must be hand-written.** Inputs generated from a schema only touch
what the schema already thought of.

## Commands

```bash
npm run build   -w @pdmux/protocol   # expect:build reads dist/, so build first
npm run expect:build -w @pdmux/protocol   # regenerate expected/*.json
npm run expect:check -w @pdmux/protocol   # regenerate in memory, compare against the committed files, exit 1 on a difference (writes nothing)
npx vitest run --root packages/protocol test/conformance.test.ts
```

`expect:build` also checks the corpus itself — it **fails** if something marked `accept` is rejected,
if something marked `reject` passes, if an `id` collides, if a `why` is empty, or if an `expected/`
entry has no case. A corpus that lies is worse than no corpus.

The vitest side (`test/conformance.test.ts`) parses with **`src/`, not `dist/`**. So if you edit the
schema and do not regenerate, that test tells you **which field moved, as a diff**.

## Adding a case

1. Add an entry to `cases` in `cases/<direction>-<verdict>.json` (`why` is required).
2. `npm run build -w @pdmux/protocol && npm run expect:build -w @pdmux/protocol`.
3. **Read** the `expected/` diff — that is the contract change.
4. Confirm with `npx vitest run --root packages/protocol test/conformance.test.ts`.

Only two TC tags are used here: `TC-PDPROTO-010` (the frame corpus) and `TC-PDPROTO-011` (the semver
tables).

## `semver.json`

Two tables: `parse` (a string → a `Semver` or `null`) and `compare` (two strings → `-1|0|1|null`).
**Here the expectations are hand-written**, because authority runs the opposite way from frame
normalisation. The source of truth for normalisation is the implementation, but the source of truth
for SemVer ordering is **the specification**. So when the table and the implementation disagree,
**the implementation is wrong**.

For `compare` rows the test asserts **the reverse direction automatically** (`compare(b, a)` = the
negated sign). A comparator that is only correct one way does not pass.

## The traps this corpus pins down (real ones from the Go port)

- **`null` ≠ absent.** `capabilities: null` (a nil slice), `resource: null` (a nil pointer) and
  `update: null` are all **rejected**. `.default()` only fills `undefined` → the field must be
  **omitted**. The cost of each rejection is, respectively: the host never registers, the whole
  heartbeat is lost, and the update capability is not advertised.
- **`0` ≠ `null`.** Across 32 nullable fields, `null` means "measurement failed" and `0` means "fine
  but idle". `uncommitted: null` (could not read) versus `uncommitted: {}` (read, and clean) is the
  same distinction.
- **A Go zero value breaks a lower bound.** `limit: 0` (`.positive()`) and `heartbeatSec: 0` reject
  the **entire** frame — and one rejected repos frame stops the git graph silently.
- **An empty string passes.** `gitStatusFile.x` has only `max(1)`, so `""` is **not rejected and is
  stored as-is** (omitting it gives `" "`). No error is recorded anywhere, so this pair of cases is
  the only way to detect it.
- **Percentages are integers.** Putting Go's `float64` CPU value (`42.5`) on the wire rejects every
  heartbeat.
- **An unknown *field* is ignored; an unknown *enum value* is fatal.** One new `capabilities` member
  drops the whole `hello` (which is why the update capability arrived as a separate object).
- **An unknown frame `type` is rejected.** The reader logs it and **discards it while keeping the
  connection** — the one thing you must always be able to tell a broken agent is "update yourself".
- **An optional with no default has no key at all.** `usageWindow.label` and `terminalTarget.session`
  produce **no key** in the result when omitted. If Go emits `""` without `omitempty`, the normalised
  result differs.

## Deliberately unspecified corners (no case on purpose)

A prerelease whose **numeric identifier exceeds 2^53** (for example `1.0.0-99999999999999999999`)
inevitably splits the two languages — JS loses precision through `Number` while Go compares integers.
It cannot occur in a real version string, so it is **not pinned as a contract**. Adding a case would
force JS's lossy behaviour onto Go, so it was left out. On the day this genuinely matters, capping the
digit count in the parser is the better answer.
