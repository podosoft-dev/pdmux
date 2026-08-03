# Coding-CLI usage collection — the part that leans on somebody else's format

Requirements: REQ-PDAGENT-024 · REQ-PDAGENT-025
Implementation: `agent/internal/usage/` · Symptom-by-symptom: [`OPERATIONS.md`](OPERATIONS.md) §5

> ⚠ **This document exists for one reason: the format read here is not ours.**
> Every other collector (CPU, memory, git, sessions) reads from the kernel or from a
> contract we defined. Usage alone reads **the internal representation of a program
> another company wrote**. That program changes without telling us, and it has changed.
> So this document is less about "how we read it today" and more about **"how to find it
> again once it moves"**.

---

## 1. Why we do not run the CLI

The agent runs on **somebody else's machine**. There is a limit to how much of that
machine you may spend to draw one bar.

One CLI used to be executed on every collection. Its launcher re-spawns a large native
binary, so every 60 seconds cost this (measured):

| | RSS | CPU |
|---|---:|---:|
| the agent itself (resident) | 24.1 MiB | 0.36% |
| launcher + native binary (for 0.8 s) | ~134 MiB | 0.28 s → 0.47% amortised |

**Asking the question cost more than the thing being measured.** Hence the rule:

> **Collection must not cost more than the agent costs at rest. Spawning a process is the
> last resort.**

The order of preference:

1. **Read what the program is already writing to disk** — cheapest, and touches no credentials
2. **Read a snapshot written by a wrapper somebody installed** — when the program leaves nothing
3. **Run the CLI** — only when neither exists, and **only as a fallback**

⚠ **Calling the official API directly is deliberately not an option.** That path means
lifting a token out of the program's credential file, pulling it into the agent process,
and sending it to an address we chose. Options 1 and 2 give **the same number without
touching a credential**. There is no reason to take the one that only adds exposure.

---

## 2. How it is read today

| Method | Where | What of theirs we depend on | What a person must do |
|---|---|---|---|
| **Session transcript** | the CLI's conversation log at `…/sessions/YYYY/MM/DD/*.jsonl` | the transcript **path convention** and the **field names** of the limit record inside it | nothing |
| **Snapshot file** | a small JSON a wrapper writes | the statusline **payload shape** | install the wrapper once |
| **Running the CLI** (fallback) | spawn `app-server`, speak JSON-RPC | the **RPC method name and response shape** | nothing |

Read cost (measured):

| | |
|---|---|
| reading a transcript | **7.6 ms**, zero processes (only the last 256 KiB) |
| reading a snapshot | one file, a few hundred bytes |
| what the wrapper adds | **0.5 ms** of CPU per call — only while that CLI is drawing its status line |
| running the CLI (fallback) | ~800 ms, ~134 MiB |

### Three rules that have to hold

1. **Never read the whole file.** A transcript passed 16 MiB within a day. Removing one
   process and introducing one full-file scan achieves nothing. Read a bounded amount from
   the end.
2. **The first line of the tail is a fragment.** Reading started mid-file, so the first
   line is cut. **A fragment that parses successfully is the dangerous one** — you then
   report a truncated record's numbers as whole values. Drop it unconditionally.
3. **Read backwards and stop at the first hit.** A transcript holds thousands of the same
   record and the values keep moving. Reading forwards reports a number from hours ago.

And **name a window by its length, not by its slot.** `primary`/`secondary` is not the
window's identity — accounts exist where the weekly window arrives in `primary` and
`secondary` is empty. Decide by length in minutes.

---

## 3. ⚠ What happens when it changes, and how you find out

**It does not quietly become zero.** When a format moves, the parser returns an empty list,
and then:

- the fallback (running the CLI) tries to answer — the values keep coming and **only the
  cost goes back to the old level**
- if the fallback cannot answer either, a `usage.unavailable` diagnostic appears on the card
- if processes are running but no window comes back, one line lands in the log:
  `Usage provider is running but reported no budget provider=<id> processes=<n>`

**So the thing to watch is not "there are no values" but "the values got expensive
again"**, because the fallback pays for this failure in resources instead of in data.
To check:

```bash
# what the agent spawns during a collection cycle — zero is correct
pgrep -P "$(pgrep -f 'pdmux-agent run')"
```

⚠ **Look at the whole process tree.** Counting only direct children is wrong — that CLI's
launcher re-spawns a native binary, so the real cost sits in the **grandchildren**. Missing
this made a measurement off by **2.8×**.

---

## 4. How to find the format again once it moves

If the format has moved, look for it in this order. This is how it was actually found.

### ① Work backwards from a real value — the most reliable

Take a number visible on screen right now (especially an **epoch integer** like
`resetsAt`) and search the CLI's whole home directory for it.

```bash
grep -rl "<the resets_at value>" ~/<that CLI's home> 2>/dev/null
```

⚠ **Do not be fooled by your own transcript.** An AI session's log contains **the value you
just printed while investigating, and the source you just read**. This caught us twice —
once a field name from source code, once a value printed a moment earlier, both showing up
as hits. **Exclude your own session file and count again.** Zero hits means the answer is
"it is not written to disk".

### ② Read the source if it is public

For a public CLI, check in its repository where the limits live. One kept them in memory
only (no disk cache), and the backend lookup path plus the headers it needed were right
there in the source. **A hosting provider's code-search API is faster than the browser** —
the web UI blocks code search without a login.

⚠ **Do not assume it is public.** One repository held only documentation, plugins and
examples — **no implementation**. Go to ③.

### ③ Read the installed artifact

Payload documentation is sometimes embedded in a binary's strings — that is exactly how the
statusline payload's field descriptions were found. Even with no source you can learn
**what comes out where**.

### ④ Where the fix goes

It ends inside `agent/internal/usage/`. The server, the contract and the UI are not
touched — what this package emits is a normalised list of windows, and that shape is our
contract.

| What changed | Where |
|---|---|
| transcript path or fields | `rollout.go` |
| snapshot keys | `snapshot.go` |
| RPC method or response | `rpc.go` |
| which CLI uses which method | `registry.go` |
| the order that prefers the cheap path | `fallback.go` — ⚠ **the order IS the saving** |

Adding a new CLI **does not require touching the agent**: an unknown id falls through to
the generic snapshot path, so a wrapper that writes one small JSON is enough.

---

## 5. For whoever comes next

- **"This CLI has a `usage` command, let's use that" is undoing the work.** Execution cost
  is why this document exists.
- **Do not delete the fallback.** It is the only answer on a host where transcripts are off
  or that CLI has never been run.
- **Do not move the fallback forward.** If the cheap path answers, the expensive one must
  not be called, and a spec locks that ordering directly (TC-PDAGENT-110). Asking both
  erases the saving.
- **Do not document the format as if it were a contract.** What is written here is an
  **observation**. The parser searching down for fields rather than pinning a path is the
  same idea — it keeps finding the answer when another wrapper layer appears above.
