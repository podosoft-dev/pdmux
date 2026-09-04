# pdmux architecture

A self-hosted dashboard for operating several development machines **from one screen**. Read
state from cards, split several terminals, and read a repository's commit graph. It is used by
a team, and the screen is **per user**.

This document records **why it was built this way** rather than what was built. Most decisions
came out of failures while actually operating an earlier tool.

---

## 1. The pieces

```
browser (SvelteKit + xterm.js)
   │  HTTPS / WebSocket — same origin, session cookie
   ▼
pdmux-api (Bun + Elysia)    Postgres  organisations, users, hosts, services, layouts, metrics, commit metadata
   ▲                        Redis     sessions, pub/sub, rate limits, job queues (retention, cleanup)
   │                        S3/MinIO  commit patch bodies
   │  WebSocket (the agent dials **outbound**, x-api-key)
pdmux-agent (one per host)  PTY · session enumeration · CPU/MEM/SWAP/DISK · service probes · read-only git · token usage
```

The desktop application keeps the same API, web application, protocol, and domain modules. Its
Electron main process only owns lifecycle and operating-system integration. In local mode it swaps
the infrastructure adapters at the existing runtime boundaries:

```
Electron → SvelteKit + API → SQLite · memory cache/events/jobs · local object storage
```

This is a deployment profile, not a fork of the product. Server deployments retain PostgreSQL,
Redis, S3-compatible storage, and BullMQ. See [`DESKTOP.md`](DESKTOP.md) for lifecycle, storage,
backup, remote mode, and packaging details.

- `packages/protocol` — the contract for both arrows above (zod). The API and the web app use
  this file directly; the Go agent reads a **JSON Schema generated from it and committed**, via
  `go:embed` (one contract, two implementations — drift is caught by comparing the generated
  artifacts).
- `packages/core` — framework-free logic (terminal grid state, gauges, sparkline geometry,
  commit lane placement).
- `packages/ui` — Svelte 5 components, kept separate from the app so another project can
  install and use them.

---

## 2. Why push rather than pull

An earlier tool had the hub **SSH into each machine** and scrape its state. That makes all of
the following prerequisites: the same network, distributed SSH keys, open inbound ports, and a
list of machines the hub knows about. A laptop, an on-premises box or another cloud stops being
a candidate at that moment.

pdmux inverts it — **the agent goes out to the server**. All it needs is one outbound TLS
connection.

| Consequence | Why it matters |
|---|---|
| Zero inbound ports or firewall holes | any environment (corporate network, home, cloud) can take part |
| No SSH key distribution | the credential is one **per-host token**, and the server stores only its hash |
| Works behind NAT | the agent holds the connection and reconnects with jittered backoff |
| Terminals use the same channel | no separate terminal server, tunnel or gateway |

There is one cost — **you have to install an agent**. How far that cost was cut decides whether
this design is actually used, so three things were shaped around that goal.

```bash
curl -fsSL https://pdmux.example.com/install.sh | sh -s -- --code pdmxe_…
```

- **One static Go binary.** The target machine needs no language runtime, compiler or package
  manager. All it needs is outbound HTTPS plus `curl` and `sha256sum`.
- **pdmux serves the artifacts itself** (`/agent/<version>/…`). No object store, no second
  hostname, no credentials — that is precisely why installation can be one line.
- **The installer is rendered per request.** It bakes its own origin, the published version and
  the sha256 of every artifact into the body. So it can be read before being piped, and there is
  no switch that turns checksums off.

What rides on that line is a **single-use, 15-minute enrollment code**, not a long-lived token.
That line gets pasted into chat, lands in shell history and gets photographed off a screen; if a
long-lived token made that journey, every copy would be a permanent fleet credential. The
code-for-token exchange happens **inside the binary**, so the token never passes through argv or
a temporary file.

After installation the server drives it remotely — collection intervals, git roots and probe
targets all come down as server-owned configuration, and **replacing the agent itself is done
from the dashboard** (§2-1).

### 2-1. Replacing the agent remotely — and the single risk it carries

SSHing into every host to swap a binary is exactly the work this tool set out to remove, so
updates come down the same socket. There is **exactly one** failure to defend against here:
**installing a build that cannot reach the server.** When that happens, the button that would
undo it is on the screen that host just vanished from.

So the ordering itself is the design — the irreversible step goes last, with **two independent
proofs** in front of it.

1. **Verify before swapping.** The running agent executes the candidate binary with `verify` and
   makes it obtain a real `welcome`. The wrong architecture, a missing dynamic loader, unreadable
   TLS roots, a regressed configuration parser, a protocol version the server now refuses — the
   whole "cannot connect" family is caught here, while **the old binary is still installed and
   still connected.** The cost of failure is one frame.
2. **Put it on probation after swapping.** A marker is written to disk **immediately before** the
   rename, and the new binary reads it **before touching the network**. The commit point is not
   process start but **a successful handshake** — a process that starts and cannot connect is
   exactly what is being guarded against, so "it started" is worth nothing here. Exceeding the
   grace period or the attempt count restores the `.bak` and exits, and the restored binary
   connects to report `rolledBack`.

The swap is **`link` + `rename`** (not two renames). A hard link does not remove the original, so
at every instant the executable path resolves to either the old inode or the new one. Two renames
create a window where the path points at nothing, and if the power goes out then, the host comes
back dark with `ExecStart=` pointing at a missing file.

Restarting is **`exit(0)`**. Both systemd's `Restart=always` and launchd's `KeepAlive` bring a
clean exit back up, so the agent needs neither privileges nor a service-manager client. With **no**
supervisor, exiting is a hole it cannot come back out of, so it does not try — it refuses with
`NO_RESTART_SOURCE`.

That this frame **grants no new power** is a property to keep defending, not an assumption. A
server that can open a PTY can already run anything on that host, so remote update is a
convenience over an existing capability — provided that ① `artifactPath` is a **path**, not a
URL, joined onto the origin in the agent's own 0600 configuration (accepting an absolute URL turns
one frame into SSRF that makes the whole fleet fetch bytes from an arbitrary origin), and ② **there
is no install-path field** (if the server chose the destination, that would be an arbitrary
file-write primitive). Both are pinned in the contract.

### 2-2. Then why not just use a mesh VPN?

What a mesh VPN solves is **reachability**, and in this design reachability is already solved —
because the agent dials **outward**. Installing a tailnet therefore removes not one inbound port.
What it does add is **another daemon** on every host, plus its account, its keys and its update
cadence.

The more important reason is that the agent **is not a tunnel**. It is not a thing that moves
traffic, it is a thing that **measures a host** — it samples CPU/memory/swap/disk, enumerates
multiplexer sessions, probes service ports, builds read-only git snapshots and **opens PTYs on that
host**. All of that has to be done by code running on that machine anyway, and that code is the
thing you have to install. A VPN does not remove that installation; it adds one on top.

There are two places where a VPN genuinely does help, and this document does not deny them.

1. **pdmux itself being reachable only inside a tailnet.** Deciding not to put the dashboard on the
   public internet is legitimate, and then the agent simply dials the tailnet address — this design
   supports that as-is (give `--server` that address). It also resolves the problem of an agent
   being blocked when a browser-oriented authentication gateway sits in front
   ([`OPERATIONS.md`](OPERATIONS.md) §2-2).
2. **A host with no outbound HTTPS at all.** Such a machine cannot meet the push model's one
   prerequisite, so something has to create a path. VPN or proxy, it is then used **for
   reachability** and not as a replacement for the agent.

### 2-3. External service reachability is a separate provider layer

The agent's outbound WebSocket makes pdmux able to operate a host; it does not make a host's own web
service reachable from another network. Card shortcuts therefore start hidden, and external service
access is modelled separately as three provider-neutral records:

```
fleet integration connection → host connector → service exposure
```

Cloudflare is the first adapter. A connection owns the encrypted API token and selected zone/policy;
a host connector owns one dedicated remotely managed tunnel and its encrypted run token; a service
exposure owns the hostname, HTTP(S) origin choice, protection mode and provider resource ids. The
separation matters during deletion: provider resources are removed while all identifiers still
exist, and database cascades happen only after that succeeds.

The public hostname is deliberately **not** implemented as another URL template. A template can draw
a link but cannot prove that DNS, ingress and authentication exist, cannot tear them down, and cannot
report connector state. A managed exposure can do all four and becomes the service's preferred URL
only after provisioning succeeds.

The model leaves room for a Tailscale adapter without pretending the providers are identical.
Tailscale Serve (tailnet-only) and Funnel (public) have different identity and policy semantics from
Cloudflare Access, so a future adapter should map the shared intent — private or explicitly public
HTTP reachability — while keeping provider-specific configuration behind its boundary. It is not
implemented in this release, and raw TCP is intentionally outside the current exposure contract.

---

## 3. Terminals: the agent opens the PTY

An earlier tool ran `ttyd` on every machine and attached to it through a **cross-origin iframe**.
That structure created:

- The browser could not read the iframe's contents, so the parent could not help with **copying a
  selection or mapping keys**.
- Keys a terminal physically cannot send (`Shift+Enter`) required **injecting a handler** into
  ttyd's index page.
- When authentication expired, the iframe was redirected to a login page which then refused to
  render under `frame-ancestors`, leaving the pane **black**.

In pdmux the agent opens the PTY, the server relays a WebSocket, and the browser draws xterm.js
**from the same origin**. Key handling, copy, paste and resize all come inside our own code, so all
three problems disappear **structurally**.

- The default target is a **persistent session** (a multiplexer). Work survives a dropped
  connection and resumes on reattach — **including the agent's own restart**. When an agent goes
  away the PTY ids it held are meaningless, but the session is not, so the relay holds those panes
  (refusing input, which would be addressed to nothing) and re-opens them with the same `open`
  frame when an agent attaches again. Only if none does within the grace period do they end.
  Ending them immediately was the earlier behaviour and it left a pane frozen until the page was
  reloaded, which from a phone is indistinguishable from a broken gesture.
- A `shell` target is warned about in the UI as non-persistent (it dies with the connection).
- Session names are limited by the contract to `A-Za-z0-9_-`, 1–32 characters — this value ends up
  as a command argument on the host.

**The edge gateway forwards upgrades directly to the API.** SvelteKit `+server.ts` handlers answer
HTTP requests but do not receive the server's upgrade callback, and the official Bun adapter does
not expose an application-specific WebSocket hook. Development uses Vite's exact-path proxy;
production uses the checked-in Caddy rule or k3s Ingress. Both route only `/terminal/ws` and
`/agent/ws` to the Bun/Elysia API, while every other path goes to the SvelteKit Bun server.

⚠ **Only those two exact paths are forwarded.** A prefix or catch-all upgrade rule would expose the
API's internal surface as a tunnel. The gateway preserves the session cookie, agent key and
forwarded address headers; Elysia authorises each upgrade before accepting it. Failed handshakes
remain HTTP 401/403/503 responses, which are diagnosable by the caller.

---

## 4. git enforces read-only **structurally**

The repositories being collected are checkouts somebody is working in. So "we do not write" has to
be a **structure**, not a rule.

- Every git invocation carries `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` — even `git status`
  does not refresh the index.
- `fetch`, `gc`, `checkout` and `prune` **do not exist in the code** (a test checks for the
  strings).
- Remote-tracking refs are therefore **as of the last fetch somebody ran by hand**, and the dock
  labels them that way.

⚠ **`ls-remote` is the one exception, and the distinction it draws is the whole point.** Both it and
`fetch` talk to the remote; only one writes. `ls-remote` asks which refs the remote has and prints
them — no objects downloaded, no remote-tracking ref moved, no `FETCH_HEAD` — so the checkout
somebody is working in is byte-for-byte unchanged. That makes it the only way to answer "what does
the remote have RIGHT NOW" without giving up the guarantee above, and it is why the whitelist gained
one entry while `fetch` still cannot be reached.

It costs a network round trip per repository, so it never rides the periodic pass: it happens when a
person presses the button, as its own pass, and a host with one unreachable remote cannot slow the
collector that has nothing to do with it.

**What it cannot answer** is how far behind you are. Counting commits needs the objects, and those
only arrive with a fetch — so a moved branch is reported as *moved*, with a number only when the
local checkout happens to already hold that object. Turning "the shas differ" into "3 commits
behind" would be inventing it.

**Lists and details are also separated.** A graph row needs only sha, parents, refs, author, date
and subject, but an earlier tool put commit bodies into the list feed as well — of 250 KB per
repository, **58% was data that was never rendered once**. Now bodies, file lists and patches arrive
**only on click**, and patch bodies live in object storage.

Coverage is **every visible commit**. Capping it at 30 means that on a screen drawing 300 rows, 90%
of clicks show nothing, and that reads to a user as **broken**, not as a limit. The cold-start cost
is handled with a **per-pass budget** instead (fill newest-first, and report what remains as
`pending` so the UI can honestly say "still collecting").

---

## 4-1. Browsing a host's files: the fence is a **handle**, not a check

The dock's second panel lists and reads files on a host. Three decisions hold it up, and they are
the same shape as §4's:

**The root is the agent account's `$HOME`.** The agent runs as the person who installed it, not as
root, and a pane's shell is that same account — so the permission check is **the operating system**,
and a file that account cannot read fails with `EACCES` exactly as it would in the terminal beside
it. Rooting the view at that account's home makes "how far can this see" a fact about the account
rather than a list somebody maintains.

**The confinement is `os.Root`.** The agent opens the home once (`os.OpenRoot`) and resolves every
name **through that handle**. `..`, an absolute path and a symlink pointing out of the tree are
refused by construction — there is no path-validation code to get wrong, which is why there is none.

- ⚠ **The contract therefore carries relative paths only.** An absolute path in a request would
  leave the handle with nothing to be relative to, and the fence would silently become a string
  comparison. `fsDir.home` travels the OTHER way (host → screen) for display and for reading a path
  a person pasted; nothing accepts it back as an address.
- ⚠ **A link written as an absolute path is refused even when it points inside the home.** Measured.
  The listing marks symlinks for that reason — an unexplained refusal reads as a defect.

**MCP cannot reach it.** The routes are ordinary REST under the session's scope gate, and the MCP
gateway does not proxy REST — it enumerates tools. So a token that was never meant to browse a
machine does not gain the ability when a route is added. That is deliberate: a dashboard user with a
terminal on that host can already run `cat`, so the explorer is convenience over a permission they
hold; a token holder with no terminal is a different grade, and giving it file access would be a new
one.

**Caps mirror the blob view's** (`FS_CAPS`), one directory per request, bytes truncated **before**
lines are split — the same order `git/tree.go` records, and for the same reason: a 40 MB file must
not become 40 MB of strings on the way to being refused.

**Downloads are the browser's job.** `GET /hosts/:id/files/download` streams the file and answers
`Range`; progress, cancel, the downloads shelf and resume-after-a-drop are then Chrome's and
Safari's, which do them well. Doing it in the page would mean holding the whole file in memory to
produce a blob URL — the one thing that breaks on exactly the large files the feature exists for.
The server pulls `FS_CHUNK_BYTES` at a time from the agent and writes each slice out with
back-pressure, checking for an aborted response **before** asking for the next one.

**Writing is a different axis from §4, not an exception to it.** git is read-only here because
those checkouts are somebody's work in progress and a dashboard has no business touching them;
the explorer writes because a person is handling files in *their own home*, from a browser
instead of from the terminal beside it — where they could already do it. The two rules do not
contradict each other, and this paragraph exists because read together without it they look
like they do.

What that costs, and what pays for it:

- The fence is the same handle, so a write cannot land outside the home either.
- ⚠ **A path that escapes is REFUSED, not reinterpreted.** The obvious normalisation
  (`path.Clean("/" + name)`) folds `../escaped.txt` into `escaped.txt` — measured while
  building the upload path, that created `~/escaped.txt` and reported success. Reading had the
  same hole and only looked safe because the reinterpreted name rarely exists.
- A new file is created **0600**; a non-empty directory is refused unless the caller says
  `recursive`; a symlink is unlinked as a link rather than followed.
- **Deleting always asks, and the question names what goes.** A count is not a question —
  "delete 4 items" reads the same whether they are scratch files or a week's work.
- The audit records **that** a file was written or removed and **where**. Never a byte of it.

⚠ **`inline` is a REQUEST, not a decision.** Content rendered from this origin runs as the app, an
SVG carries script and an HTML file plainly is script — and the explorer is a way to put such a file
on a host. So the allowlist (`@pdmux/core`'s `INLINE_SAFE`) is raster images, everything else is an
attachment however it was asked for, and `X-Content-Type-Options: nosniff` stops the browser from
overruling a type that was itself guessed from a name.

---

## 5. Why the components are separate packages

The dashboard UI is not only this app's. Another project should be able to take just the "host card"
or the "terminal grid". So the rules are enforced by tests:

- `@pdmux/ui` **does not import** `apps/*`. No global stores, no direct `fetch`.
- Data comes in as **props**, behaviour as **callbacks**, and remote calls only through injected
  adapters (`TerminalAdapter` and friends).
- User-facing strings are injected as props or through an optional `t()` — the consuming app's i18n
  owns them.
- Styling is Tailwind utilities plus CSS variables, so it does not collide with the consuming app's
  design tokens.

`packages/core` is one level below that — it does not even know about Svelte. That is what lets the
layout reducer and the lane-placement algorithm be tested **without a browser**, and those tests are
the behavioural specification.

---

## 6. Personalisation is stored on the server

An earlier tool kept the layout in `localStorage` only. The result: no concept of a user, the screen
vanishing when you changed machines, and no way to have anything like "my list of servers".

pdmux keeps `UserLayout` (split arrangement, pages, slots) and `UserHostPref` (which widgets are on
in a card) **per user, on the server**. localStorage is used only as a cache to make the first paint
fast. The host list itself is **scope-level** data and is **added, edited, deleted and reordered from
the UI** — no more editing constants in a script.

Scope here is the active organisation, and **the user themselves when there is none**
(`personal:<userId>`). In an installation that does not use organisations — which is most of them
today — that means the host list is effectively **per user**, which is why registering your own
machine does not need an administrator. An organisation fleet is shared, so its rules differ —
there, only an administrator changes it.

---

## 7. Screens are verified by **geometry**, not by the DOM

In an earlier tool the same symptom ("clicking a commit shows no detail") was fixed three times, and
all three were wrong. The real cause was that **the mount host had no CSS rule**, so the page grew to
its content height (7,930 px) — the list never became a scroll container, and the detail panel was
drawn 7,300 px below the viewport and clipped by `overflow:hidden`.

Three misses happened because **every check was a DOM query**. The content was always "there". What
was missing was **its position on screen**. So the UI tests in this repository measure:

1. whether the list is a real scroll container (`scrollHeight > clientHeight`) and whether the
   scrollbar takes up space
2. whether the clicked detail is **inside the viewport** and reachable via `elementFromPoint`
3. whether the page itself does not scroll (whether the layout is contained by the viewport)

For the same reason splitter drags use `setPointerCapture` — document-level listeners lose events the
moment the pointer enters an iframe or canvas, and the drag freezes (measured).

And that shell is **a layout, not a page**. The layout of the `(shell)` route group owns the card
column and the splitters, while `/` (terminals and the commit graph) and `/hosts` (host management)
draw their own content in the remaining track. When the sidebar was content of the dashboard **page**,
opening host management made the fleet vanish, and coming back re-seeded cards, polling and column
widths from server values. Shared state is passed through Svelte context — a module singleton is
shared across requests under SSR, so another user's fleet bleeds into the first paint. There is one
cost and it is not hidden: the terminal grid is still owned by the dashboard page, so leaving for
`/hosts` unmounts the panes. Because the default target is a multiplexer session, the work survives
and reattaches to the same session on return.

### 7-1. Grid placement must be **explicit** — implicit tracks silently eat the screen

The second edition of the same lesson arrived on mobile. The narrow-screen template declared two rows
while the shell had five in-flow children, and placement was **entirely auto**. Hiding a splitter with
`display:none` shifts everything up one cell and the dock takes an **implicit `auto` row**. That row
inflates to the commit list's intrinsic height and the terminal row, which is `minmax(0,1fr)`, is
crushed to zero — measured `320.7px 0px 523.3px`, pane grid **366×0**. Four panes were sitting
perfectly in the DOM.

Two rules pinned it:

1. **Every child is placed by role** (`data-pdmux-region` / `data-pdmux-sidebar` /
   `data-pdmux-handle`), and where an unknown child goes is **an area cell, not a new row**. The
   track count stops depending on the child count.
2. **Mobile is the base and desktop is a `min-width` override.** The other way round becomes a
   specificity fight — `[data-sidebar='hidden'][data-dock='open']` (0,3,0) beat the media block
   (0,2,0), so the desktop's five columns survived on a 390 px screen
   (`0px 0px 0px 6px 420px`). `@media` does not raise specificity. Leaving no rule below that could
   win is better than winning.

Within one file, **an override of equal weight must come after the rule it targets** — putting it
before silently displaced the refs panel width and the date column rule (which only measurement
revealed). So the two phone-only blocks sit at the **very end** of the stylesheet, with a comment
guarding the reason.

And **width and pointer are different axes**: width (`max-width: 900px`) decides what to show, pointer
(`(pointer: coarse)`) decides how large to show it. Mixing them gives a touch laptop the phone layout,
or a narrow desktop window finger-sized buttons.

---

## 8. Test architecture

| Layer | Runner | Character |
|---|---|---|
| `packages/protocol` | vitest | contract schemas — offline and deterministic, with a frozen key set protecting compatibility |
| `packages/core` | vitest | pure functions — no browser needed |
| `packages/ui` | vitest (+jsdom) / Playwright | render and callbacks / **geometry** (§7) |
| `apps/api` | jest | entities, permissions, ingestion, retention |
| `agent` | `go test` | parsing, backoff, read-only invariants, PTY round trips (a Go module, not a Bun workspace) |
| e2e | Playwright | login → register host → agent connects → terminal → graph → layout saved |

Every test title carries a `[TC-AREA-NNN]` tag, and a traceability checker verifies that the
requirement documents and the code agree.

---

## 9. Operational constraints that shaped the design

- **No caching**: the dashboard feed changes every second. Allowing a cache on a non-static response
  produces "I refreshed and got the old screen" (an incident we actually had). API responses are
  `no-store`.
- **A long loop re-reads its own code**: if code changes while a collection loop is running, it keeps
  running as a mixture of old and new. The agent reports its version in `hello` and the server puts
  that value on the card, so what is running is visible.
- **Shared-workstation manners**: tests start one browser and do not run heavy builds in parallel.

---

## 10. Where AI attaches is the host

pdmux serves one MCP endpoint (`<origin>/mcp`). It exists so a coding CLI running on that machine can
read the host and run commands without opening the repository, and three things decide the design.

**The credential's scope is a host.** pdmux has no concept of a project and enrollment is per person —
a host is the only thing available as a boundary. So no tool takes a host id as an argument. Having no
argument to validate leaves fewer places to be wrong than taking one and checking it every time. There
is also no tool that **creates** a host: with one, the credential would widen its own scope.

**The endpoint keeps no state.** A server instance is built per request and discarded when the response
closes. With no session store there is no expiry, no sticky routing and nothing to lose on restart. The
cost is rebuilding the tool list per request, and it is small.

**Tools call services; they do not call our own REST API over loopback.** The latter is tidier in that
authorisation lives in one place, but it requires the fleet routes to accept this credential — and at
that moment a leaked key's radius becomes "whichever controllers happen to be open today". Enumerating
the surface makes widening the permission a reviewable line, and the single gate of the scope filter
(`HostsService.get(scope, id)`) stays where it is.

Why command execution is **the only non-measuring action** in this product is covered in
[`CONTRACTS.md`](CONTRACTS.md) C6-2.

---

## 11. Machines are not shared — the owner is corrected

A host belongs to **the account that was logged in when it was registered**. That produces one common
mistake: there is one machine, but the host is created under the wrong account, and the account you
meant to use is left with an empty row holding zero tokens that looks like "a machine that
disconnected". If the labels match too, there is no way to tell the two rows apart on screen.

The requirement that naturally follows is **"let several accounts see one machine"**, usually
implemented as an access list attached to each host. **We decided not to build that.** For two reasons.

**One — this product cannot pay for it.** `metricStepSec` is applied **when a sample is written**.
There is one stream per host, so "a different interval per viewer" has no answer at all.
`heartbeatSec` produces the online verdict, so two scopes with different values give different answers
about the same machine. Label uniqueness and `sortOrder` are also per scope, so a recipient's ordering
disturbs somebody else's rows. And when the owner disables the host, the socket closes and **the
recipient's terminals die with it.**

**Two — the tools that install agents do not do it that way.** Of six that were surveyed (a metrics
exporter, an observability agent, an APM agent, a mesh VPN, container management, remote shell access),
**not one has the agent carry a user identity.** All of them are single-credential endpoints, and
tenancy is decided on the server **by group** — spaces, organisations, tags, labels. Per-resource access
lists exist only as narrow exceptions, and those projects explicitly warn that they become unmanageable
at scale. Even the tool that handles remote shells expresses "this person may open a shell on that
machine" **through labels and roles, not a table keyed by node id**.

**So the answer is moving the host.** Correcting the owner adds no new concept and
solves exactly the observed problem. Why moving does not disturb the agent was already in place —
tokens, services, repositories and metrics all hang off `hostId` and follow the row, and the scope is
re-read where it is used, so from the next heartbeat it picks up the new scope's settings. No
reinstall, no reissue, no socket reconnect.

If a day comes when several people **genuinely** must share one machine, what is needed then is not a
per-host access list but **an organisation** — the group unit the industry converged on, and one this
repository already has switched on.
