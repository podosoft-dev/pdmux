# Contracts (agent ↔ server ↔ browser)

The source of truth is **the code** — the zod schema in `packages/protocol/src/index.ts`.
This document explains *why* the contract has that shape and the rules for changing it. If
the schema and this document disagree, **the schema is right** (and this document gets
fixed).

---

## C0. The evolution rule — **additions only**

Agents are installed on machines that cannot be upgraded today. Renaming or removing a
field breaks those machines immediately.

- New fields are added **optional, or with a default** — never any other way.
- The **meaning** of an existing field never changes (including units and polarity).
- Unknown fields are **silently ignored** → a new agent still talks to an old server.
- If something genuinely must break, raise `PROTOCOL_VERSION` and **keep the old reader**.
- The set of top-level keys is frozen by a test (`TC-PDPROTO-007`). If that test breaks,
  the change was not an addition.

---

## C1. Authentication and connection

| | |
|---|---|
| Agent endpoint | `GET /agent/ws` (WebSocket upgrade) |
| Browser terminal | `GET /terminal/ws` (session-cookie auth; the server relays to the agent) |
| Agent credential | `x-api-key: pdmux_…` — the server stores **only a hash** and shows the plaintext once, at issue |

The agent **always dials out**. The server never opens a connection to an agent — that is
what lets a machine behind NAT or a firewall take part unchanged. On disconnect it
reconnects with jittered exponential backoff, queueing readings locally in the meantime and
resending them (bounded, dropping the oldest at the cap rather than growing forever).

**The key travels as a header** (`x-api-key`), not in a query string. A URL is written into
the access log of every proxy between here and the server, and a credential in such a log
becomes somebody else's log rotation's problem.

### C1-1. Enrollment — exchanging a one-time code for a token

`POST /api/agent/enroll` — a **public endpoint**. A machine mid-installation has no session
and no credential, because **the code is the credential**.

```
request   { code, hostname?, os?, arch?, agentVersion? }
response  { hostId, hostLabel, token, tokenId, tokenName }
```

| | |
|---|---|
| Code format | `pdmxe_` + 20 Crockford base32 symbols (dashes are decoration) = **100 bits** |
| Lifetime | **15 minutes**, **single use**, **at most one per host** (enforced by a partial unique index) |
| Rate limit | **10 per minute** per client address |
| Refusal | malformed, unknown, expired, spent, revoked — **all the same 401 `ENROLL_CODE_INVALID`** |

- **Why a code and not a token**: that one line gets pasted into chat, lands in shell
  history, and gets photographed off a screen. If a long-lived token made that journey, every
  copy would be a permanent fleet credential. A code dies in minutes.
- **Why the alphabet has no `I·L·O·U`**: this is a value read off a screen and typed into
  another machine. Removing the confusable letters means misreading `0`/`O` **cannot produce a
  different valid code** — it either normalises to the same code or to nothing. Having no
  shell metacharacters matters too (it goes through `sh -s -- --code …` unquoted).
- **Why failures are not distinguished**: distinguishing them turns the endpoint into an
  oracle that says "this code exists, it is merely expired". An operator sees the real state
  (`live`/`consumed`/`revoked`/`expired`) at `GET /hosts/:id/enrollments/current`.
- **The code goes in the body, not a header.** The web tier forwards only a **fixed header
  allowlist** to the API, so a custom header never arrives at all — the API sees a request
  with no credential whatsoever and answers 401 to a perfectly good code.
- **The `POST` does not follow redirects.** curl and HTTP clients resend the body on 307/308,
  so following one delivers the code to a different host.

⚠ **The fields the installer sends are "optional, additive only", and that rule is made by
the pipeline, not the DTO.** The API runs
`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` — a property
`EnrollAgentDto` does not declare is **not quietly dropped, it is a 400**. So a new installer
that starts sending a sixth field **fails completely** against an API that has not shipped
yet. The order is always **add the field to the DTO → deploy → then start sending it**.
`hostname`/`os`/`arch`/`agentVersion` are for the audit record and are **not authoritative**
— the host row's values come from `hello` once the agent attaches.

`POST /hosts` **returns a code alongside the created host** (`enrollment`). If issuing the
code fails, host creation still stands (`enrollment: null`) — an operator must not lose a
host over one code.

---

## C2. Envelopes

```
agent → server : hello | heartbeat | repos | terminal | pong
server → agent : welcome | config | terminal | ping | collect | commitDetail | detailAck
```

- `hello` carries protocol and agent versions, OS, architecture and capabilities, because the
  card has to be able to show **what is actually running** (this prevents a recurrence of an
  earlier incident where the code changed and the old loop kept running).
- `welcome` gives `hostId` and **the configuration the server owns** (`AgentConfig`).
  Collection intervals, git roots and probe targets have to be changeable without getting back
  onto the host.
- `collect` requests one immediate collection (so pressing "refresh" does not mean waiting two
  minutes).
- `commitDetail` requests **a commit patch that is not there yet, on the spot** — the server
  sends it when a lookup falls through to uncollected, and the agent answers with a
  `partial: true` snapshot (details only). The lookup does not wait for the answer (the patch
  arrives through the ordinary ingest path). To stop polling from multiplying, the same
  (host, repoPath, sha) is sent once until an answer arrives, forgotten after 30 seconds,
  capped at 50 in flight per host (= the per-frame sha cap), and nothing at all is sent to a
  disconnected host.
- `detailAck` tells the agent **which shas the server already has**. Details are immutable per
  sha, so this keeps a restarted agent from spending its pass budget reproducing patches that
  are already stored.

---

## C3. Heartbeat (`heartbeat`)

Carries resources, sessions, agent usage and service probes in one frame.

- Percentages are **integers 0–100**. The UI needs no more resolution than that.
- **Absolute bytes travel alongside** (`memUsedBytes`/`memTotalBytes`, same for disk and swap)
  — the tooltip's `12Gi/30Gi` cannot be produced from a percentage.
- A failed measurement is **`null`**. Substituting `0` makes it look like "healthy but idle".
- ⚠ **Swap has a third state the other two do not, and it is not an exception to the rule
  above.** A host with swap turned off — every container, every server built without it —
  reports `SwapTotal: 0`, and that is a **successful measurement**: nothing is swapped
  because there is nowhere to swap to. So it sends `swapPct: 0` with `swapUsedBytes: 0` and
  `swapTotalBytes: 0`, while all three `null` keeps meaning what it means everywhere else:
  nobody could look — which is also what an agent older than `0.1.16` produces, since the
  keys default to `null`. The two must stay distinguishable, or upgrading such an agent
  appears to change nothing. On the card both read `0%` and the byte hint separates them:
  `0B/0B` has nowhere to swap to, `0B/8Gi` has somewhere and has not needed it.
- With no multiplexer, the session list is an **empty array**, not an error.

### Usage windows

Providers split between reporting **what is left** and reporting **what was used**. The
contract carries both (`usedPct`/`remainingPct`), the card always draws **what is left**, and
the tooltip shows the same number the provider's own UI does.

- An unsupported window **produces no row** (an empty gauge promises data that is not coming).
- A window whose `resetsAt` has passed is **discarded** — its numbers describe a window that
  already reset.
- Process counts use **exact process-name matching** (grepping the command line over-counted
  8 versus 4 in measurement).

#### What the host side needs (⚠ the installer does not create it)

Each provider is collected differently, and **both need preparation on the host**. This
requirement was written down nowhere, and as a result one deployment was silently dead
end-to-end — the card said only "no budget reported", with no reason in any log, diagnostic
or API response.

| Provider | Method | What the host needs |
|---|---|---|
| `claude` | **snapshot file** | a statusline wrapper writes `~/.claude/pdmux-usage.json`. The agent spawns no process (to avoid touching credentials). |
| `codex` and similar | **JSON-RPC** | the CLI binary must be executable **and able to find its own runtime on PATH**. |
| anything else | snapshot file | a wrapper writes `~/.config/pdmux/usage/<id>.json`. |

Two traps found by measurement:

1. **A snapshot filename outlives the deployment that chose it.** A previous tool's wrapper was
   writing a perfectly good snapshot every few seconds under an old name while the agent read
   `pdmux-usage.json`. So the agent **also reads known legacy names as candidates** (the current
   name always wins).
2. **Finding the binary is not enough.** These CLIs are `#!/usr/bin/env node` scripts and look
   up their runtime on PATH at execution time. `systemd --user`'s PATH has no nvm, so codex ran
   under the distribution's node 12 and died with a `SyntaxError`. The agent therefore
   **prepends the discovered binary's real directory to the child's PATH** (following symlinks).

⚠ **Processes running with zero windows is not normal.** That combination is now caught by the
`usage.unavailable` diagnostic and left in the agent's log along with the paths it tried.
Previously it counted as "reporting" merely because a row had been drawn, and passed silently.

---

## C4. Repository snapshots (`repos`)

- **Rows and details are separated.** A commit row carries no body and no patch key at all
  ([`ARCHITECTURE.md`](ARCHITECTURE.md) §4).
- Details are **immutable per sha**, so once stored they are never rebuilt. A commit whose
  patch is **empty** — a merge seen through `--first-parent`, for instance — is stored too, as
  `empty: true`; not storing it means recomputing it every pass and eating the whole budget.
- The caps (`DIFF_CAPS`) are applied **by the agent**: 200 KB per commit · 800 lines per file ·
  **500 characters per line**. Limiting only the line count lets one enormous line from a lock
  file through and produces a multi-megabyte payload (measured).
- Coverage is **the whole visible window**; filling is **a per-pass budget**. What remains is
  reported as `pending` so the UI can say "still collecting (N left)".
- One repository's failure ends as that repository's `error` — no effect on the others or on
  other hosts.
- The server announces shas it has already stored via `detailAck`. Details are immutable, so
  without it **a restarted agent spends every pass's budget rebuilding patches that already
  exist**.
- A click is answered with a `partial: true` snapshot carrying **details only** (it does not
  rebuild the whole graph).
- `gone` (a vanished upstream) and `submodules` (moved submodule pointers) let the UI describe
  the state where a tree looks clean but committing drags something along.

---

## C5. Terminal frames

```
open(termId, target{kind,session,cols,rows}) → ready(pid) | error
input(termId, data) / resize(termId, cols, rows) / close(termId)
                                   ← output(termId, data) … exit(code)
```

- The default target is a **persistent session**, because work has to survive a dropped
  connection; the non-persistent (`shell`) case is warned about in the UI.
- Session names allow `A-Za-z0-9_-` only, **1–32 characters**. This value becomes a command
  argument on the host.
- When output outruns consumption (a build log, `yes`), the agent **drops the oldest bytes at
  the buffer cap (`terminalBufferBytes`) and reports how many via `output.dropped`** — it does
  not silently corrupt the stream.
- The server is both relay and **authorisation point**: it checks that the session's user may
  see that host, and records opening a terminal in the audit log.

---

## C6. Service probes

A host's registered services (label, port, probe method, URL template) are **server data**. The
agent probes the list of ids the server gave it and returns `up|down|unknown`.

Collection intervals, probe timeouts, status caps, body lengths and terminal buffers are
**server settings** (range-bounded, so a bad value cannot abuse a host). Nothing is hard-coded
in the agent.

- The card's shortcut list comes from this data — the dashboard keeps no separate list (in an
  earlier tool the constants in a tunnel script were the source of truth, so it could not be
  changed from the UI).
- `unknown` means "not probed" and is different from `down`. It is fine to open, but no
  response is promised.

---

## C6-1. Remote update frames

```
server → agent : update(commandId, version, artifactPath, sha256, bytes, os, arch, force, probationSec)
agent → server : updateStatus(commandId, phase, progressPct, currentVersion, targetVersion,
                              code, message, shellPanes, sessionPanes)
```

**`hello.update` — can this host be updated at all?**

```ts
{ canRestart: boolean, restartMode: 'systemd' | 'launchd' | 'none' }
```

A remote update ends with the agent replacing its own binary and **exiting**, so something has
to bring it back. Under systemd (`Restart=always`) or launchd (`KeepAlive`) that is free and
needs no privileges. With no supervisor (run straight from a terminal, or a `--no-service`
install) exiting is **a hole it cannot come back out of**, so the server must not offer the
button in the first place.

⚠ **Why a new object rather than a member of `capabilities`**: `capabilities` is a zod `enum`.
If a new agent sends a member an old server does not know, the element fails → the array fails
→ **the whole `hello` fails.** That host vanishes from the dashboard silently. An unknown
**field** is dropped; an unknown **enum value** is fatal.

**`update` — "replace yourself with this build"**

This frame **grants no new power**. That is not an assumption but a property to keep defending,
and two choices are what create it.

1. **`artifactPath` is a path, never a URL.** The agent joins it onto the origin in its own 0600
   configuration — the origin it authenticated against. Accepting an absolute URL would make one
   frame able to "have the entire fleet fetch bytes from an arbitrary host", which is not a
   convenience but **a new power (SSRF)**. The pattern is in the contract: it must start with
   `/`, **the second character must not be `/`** (`//evil.example/x` is a protocol-relative URL
   and resolves to another host), and `:`, `?`, `#`, `@` and whitespace are excluded. **No
   lookahead is used** — Go's RE2 has none, and a pattern the two runtimes read differently is
   worse than a slightly clumsier one.
2. **There is no install-path field.** The agent replaces `os.Executable()` and nothing else. If
   the server chose the destination, that would be an arbitrary-file-write primitive.

`sha256` pins the bytes. **Be honest about what that buys**: the side declaring the hash and the
side serving the bytes are the same server, so this defends against **a corrupted or swapped
static object**, not against a compromised pdmux. A signature field is better **absent** than
half-done, and adding `sig`/`sigAlg` later is an addition.

`bytes` is both the exact size and **the agent's read cap** (a truncated body and an endless one
both stop there). `probationSec` is 30–1800, default 300. `force` skips **the version comparison
only** (a deliberate downgrade) — verification and probation still happen, and the version named
still has to be one that server actually holds, which on a container deployment is one version
([VERSIONING.md](VERSIONING.md) §7-1).

**`updateStatus` — progress and outcome in one type**

`accepted → downloading → verifying → swapping → restarting → done | failed | rolledBack`

- **Who sends what**: `done` comes from **the new binary** after it completes its own handshake;
  `rolledBack` comes from **the old binary** after it restores itself. Every outcome arrives from
  **a connected agent**, so the server never infers failure from silence — that inference turns a
  slow host into a false alarm.
- `commandId` is an **idempotency key**. Re-sending the same id is not a second download but **a
  re-report of the current phase**, which is what makes the server's retries safe.
- `code` is a **stable reason code** (`NOT_NEWER`, `SHA_MISMATCH`, `ARCH_MISMATCH`, `BUSY`,
  `EXE_NOT_WRITABLE`, `NO_RESTART_SOURCE`, `RATE_LIMITED`, `VERIFY_FAILED`, `SWAP_FAILED`,
  `STATE_UNWRITABLE`, `PROBATION_EXPIRED`, `PROBATION_ATTEMPTS`, `SWAP_INCOMPLETE`,
  `ROLLBACK_FAILED`), so the UI can group without matching prose. **Adding is an addition;
  renaming breaks a filter somebody built.**
- `currentVersion` is **what is running right now** — the stored row can be stale, so this value
  is authoritative.
- `shellPanes`/`sessionPanes` travel with `accepted`. They are what lets the confirmation dialog
  speak in numbers, and an attached terminal is **a warning, not a refusal** (a development fleet
  always has something attached, so refusing would make the button never work and send people
  looking for `force` — at which point the safeguard is just noise).

**The verification dial**: a candidate binary connects to `/agent/ws?mode=verify`. Authentication
is exactly identical (same token, same disabled-host rule) and it receives the same `welcome`, but
it **leaves nothing in the registry, the host row or the ack ledger.** Connecting normally would
make the gateway's "one socket per host" rule close the existing connection with code 4000 and
**invalidate every PTY on that host** — this mode exists so that verifying is not itself an
incident. ⚠ This flag is **not a security control, because a client can leave it off**. That is
why the credential side (token resolution, revocation check, `lastUsedAt`) is identical in both
modes and only **the fleet-state side** is skipped.

---

## C6-2. Command execution frames (`exec` / `execResult`)

Run one command on a host and get the result back. It is **the only thing in this contract that
is not a measurement** — it changes the machine — so its limits live in the shape of the frame
rather than in the agent's good intentions.

```
server -> agent   { type: 'exec', exec: { commandId, command, args[], cwd|null, timeoutMs } }
agent  -> server  { type: 'execResult', result: { commandId, exitCode, stdout, stderr,
                                                  truncated, timedOut, code|null, message } }
```

⚠ **The executable and its arguments are separate, and no shell is involved.** A single string
would have to reach `sh -c`, and at that moment one unquoted argument becomes a second command.
The agent execs the binary directly, so `;`, `&&` and `$(…)` stay characters inside an argument.
When a real shell is genuinely needed, the caller says `command: "sh"` explicitly and takes on
the quoting.

⚠ **The terminal frames (C5) cannot substitute for this.** A PTY gives a stream mixing prompts,
echo and ANSI, and **carries no exit code** — the caller cannot tell success from failure. This
frame gives up interactivity in exchange for an answer.

**Reading the result**

| Field | Meaning |
|---|---|
| `exitCode` | the verdict. `-1` means it died or never started |
| `timedOut` | **we stopped it** — different from it failing |
| `code` | why it was refused before running (`COMMAND_NOT_FOUND`, `EXEC_BUSY`). `null` if it actually ran |
| `truncated` | output was cut at 64 KiB (`EXEC_OUTPUT_MAX`) |

The output cap is **deliberately different** from the agent's internal cap (32 MiB): the latter is
a number about output the agent consumes itself, this one is about output put on a WebSocket and
sent to a caller.

⚠ **`exec` is declared as a capability in `hello`.** An agent built before it **silently ignores**
the frame, so the server reads the capability before sending — otherwise the caller waits for an
answer that is not coming. `MIN_SUPPORTED_AGENT` is not raised (an old agent is not incompatible;
it just lacks this feature).

---

## C7. HTTP response conventions

- Errors follow the **error envelope**:
  `{ success:false, error:{ code, message, statusCode, path, timestamp } }`. Clients **branch on
  `code`** and never depend on the message string.
- Dashboard feed responses **forbid caching** (`no-store`). Caching data that changes every second
  produces "I refreshed and got the old screen", and that is an incident we actually had.
- A list endpoint has to be able to paint **one screen in one request** (the host list = latest
  heartbeat + service status, joined).
