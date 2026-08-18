# CHANGELOG

## 0.9.1

- **A pane survives its agent restarting.** An agent going away used to end every pane on that
  host — right about the PTY ids it held, wrong about the work, because the default target is a
  multiplexer session that outlives the agent and the browser's own socket never dropped. The
  pane simply froze until the page was reloaded. Panes now wait instead, refusing input while
  they do, and are re-opened with the frame they were opened with the moment an agent attaches;
  a session reattaches with its scrollback. A `shell` target cannot be resumed and gets a fresh
  one rather than a dead pane. Two minutes without an agent and they end the way they always
  did — a pane waiting forever is the worse failure.

## 0.9.0

- **A flick keeps travelling.** Matching the finger is the right answer for placing the view and
  the wrong one for travelling — an hour of a coding agent's transcript is an hour of dragging —
  so a release with speed on it now flings: velocity is measured over the last moves and decays
  after the release, feeding the same notch machinery the drag uses. Flicks compound within 300ms,
  a finger down stops it, and it is bounded three ways rather than trusted, because nothing ever
  reports how far a notch actually moved the program.
- **Notches leave at a hand's rate, and wait for the pane to answer.** A fling emitting one per
  frame put about ninety reports a second on the wire; no mouse spins that fast, and a program is
  free to fold such a burst into a single scroll — one coding agent's TUI does, which is why the
  same gesture worked on the pane beside it and not on that one. Worse, sending ahead of a program
  that reads input on its own render loop builds a backlog, which arrives later as scrolling
  nobody asked for. So one notch is outstanding at a time: the next goes when the pane repaints —
  the only acknowledgement a terminal offers — or after a ceiling, and the queue is bounded in
  time rather than in count. The wait applies only where something can answer; moving the
  terminal's own viewport produces no output, and waiting there would throttle a pane that is
  working fine.
- **A drag asks the multiplexer instead of typing at the program.** On a pane whose program is not
  holding the mouse, the wheel's cursor-key fallback does not scroll anything — the multiplexer
  forwards keys to whatever runs inside it, so an arrow meant as a scroll walks a coding agent's
  prompt history. Such a drag now asks for the multiplexer's own scroll mode, and the program is
  handed nothing. A full-screen program in a plain pane is unaffected: it is the program, and the
  keys still reach it.
- **A pane says what a gesture did, and whether it could.** `?gesture=1` draws one line over each
  pane — which buffer, whether the program holds the mouse, where the gesture went, what is queued
  behind it and how long the pane took to repaint. A phone has no console, and those three routes
  are invisible from anywhere else. The transport gets a line of its own whether or not the flag
  is on: a suspended tab drops what is sent while it reconnects, and until now the only notice of
  that was written into a buffer the multiplexer immediately painted over.

## 0.8.1

- **A drag is scaled to whoever answers the wheel.** Reported from an iPhone once the gesture
  worked at all: it scrolled far too slowly. One notch per three rows of travel tracks the finger
  exactly while the terminal answers — its cursor keys and its own viewport both move three lines
  per notch — but a program holding the mouse decides for itself and moves less, so three rows
  bought a fraction of a screen. The notch is one row while mouse reporting is on and three rows
  otherwise, asked per move because a program turns reporting on and off as it runs. The fling cap
  is now twelve rows of travel rather than a notch count, so the ceiling means the same thing on
  both scales.

## 0.8.0

- **A finger reaches what the wheel reaches.** Reported from an iPhone: a pane running a
  coding agent would not scroll, so the progress had to be read on a desktop. Everything
  that scrolls a pane is now one path — a drag, the ⇞/⇟ buttons and `scrollPages()` all
  dispatch a wheel event and let the terminal route it, because which of three answers is
  right (a mouse report for a program that asked for one, cursor keys for a buffer with no
  scrollback, or its own viewport) is only knowable at that instant and only the terminal
  knows it. The drag used to hand-roll the middle answer and stand down whenever the program
  held the pointer, which is precisely the state a full-screen agent TUI is in — so a phone
  had no gesture at all on the panes this product exists to watch. The surface declares
  `touch-action: pan-x pinch-zoom` so the engine cannot claim the vertical axis and make the
  gesture uncancellable; pinch-zoom and the browser's own back swipe stay.
- **The output sheet says what it cannot hold.** A sheet with one screen in it, a sheet still
  fetching and a sheet whose fetch was refused were the same picture, and in the worst case it
  said "nothing has been printed yet" about a pane that had printed for hours. Each state now
  has its own line, including the one that matters most: when a full-screen program owns the
  pane, the multiplexer kept nothing above its screen either, so the note points at the
  program rather than at a history nobody has. An empty answer is reported as an answer and a
  refusal as a refusal.
- **The whole capture, not the first two windows.** The walk stopped as soon as a window came
  back with fewer lines than the rows it asked for — which `-J` makes routine, since joining
  wrapped rows is the point of that flag. It now walks to `#{history_size}`, the number the
  multiplexer itself keeps: measured against a live pane, 814 lines where it used to stop near
  400. A window asked for past the top returns the visible screen rather than nothing, so a
  window that repeats the newest one ends the walk.
- **A pane comes back when the tab does.** A phone freezes a backgrounded tab, timers
  included, so a socket that died overnight stayed down well past the screen coming back and
  the pane showed its last frame — indistinguishable from a session that stopped. Returning to
  the tab now cancels the pending backoff and reconnects immediately, and the keyboard sensor
  re-measures at the same moment, so a shell suspended with the keyboard open no longer stays
  short.

## 0.7.0

- **A host's files, in the dock beside its commits.** The panel lists the home
  directory of the account the agent runs as, reads a file into the same viewer the
  git blobs use, and shares the dock column with the commit graph so an operator can
  watch a build and read the tree it is building at once. It is not a new power:
  whoever can reach it can already open a terminal on that host as that account and
  `cat` anything it reaches, which is exactly why an MCP credential cannot — the
  gateway enumerates tools rather than proxying REST, so a token with no terminal
  gains nothing from a new route.
- **The fence is a handle, not a check.** The agent opens `os.OpenRoot($HOME)` once per
  request and resolves every name through it, so `..`, an absolute path and a symlink
  leaving the tree are impossible rather than rejected — and there is no path-validation
  code, because validation is code that can be wrong. A path that escapes is refused
  rather than reinterpreted: the obvious normalisation folds `../escaped.txt` into
  `escaped.txt`, which on the write path created a real file and reported success.
  The price is recorded too — an absolute symlink target is refused even when it points
  back inside the home, so such links are listed and marked rather than silently broken.
- **Downloads belong to the browser, and resume for free.** Transfers are addressed by
  byte offset, so a resumed download is the same request as a first one and an abandoned
  one leaves nothing on the host — no session, no open handle, nothing to reap. The page
  is given a `Range`-capable URL rather than bytes, because routing a file through the
  app means holding it in memory to make a blob URL, which fails on exactly the large
  files the feature is for. Progress, cancel and the downloads shelf are then the
  browser's, which does them well.
- **Uploading, and deleting that asks first.** Files arrive by toolbar picker or by drag
  from Finder or Explorer, sliced on the way through so a two-gigabyte upload is never
  two gigabytes of server memory. A new file is created `0600`. A non-empty directory is
  refused unless the caller says `recursive`, because "delete this folder" and "delete
  this folder and the four thousand things in it" are different sentences and the screen
  can only ask the second honestly if the first cannot quietly do it. A symlink is
  unlinked as a link rather than followed. The confirmation names what goes: a count is
  not a question. Neither the audit entry nor the answer frames carry any content — an
  upload is the surface most likely to hold a secret.
- **Writing is a different axis from git's read-only stance, not an exception to it.**
  git is read-only here because those checkouts are somebody's work in progress; this is
  a person handling files in their own home. `ARCHITECTURE.md` §4-1 says so, because read
  together without it the two rules look like a contradiction.
- **A file is read by colour.** Directory, code, data, prose, image, archive — the roles
  map onto the six code-highlighting tokens the blob view already defines for light and
  dark, rather than a second palette to keep contrast-correct. The path bar shows the
  full path with every segment clickable, and pasting what `pwd` printed navigates there.
- **A truncated file no longer renders off its own panel.** The blob view's truncation
  note was a third grid item, so it was auto-placed into the line-number column and its
  sentence sized that track — measured at 268px of line numbers beside 140px of code.
  It was always wrong in the commit dock; the file explorer is where somebody finally
  looked.
- Agent 0.1.21 carries all of it. An older agent ignores the new frames, so the server
  reads the `files` capability first and the panel says the host cannot answer rather
  than waiting out a timeout.

## 0.6.0

- **A host card folds to its header, and stays folded.** A fleet that grows past a
  screenful spends the left column on machines nobody is watching, so each card now has
  a chevron and the fold is remembered per host on the server — the same row the widget
  switches already use, so it follows the operator to another device rather than living
  in one browser. Collapsing is deliberately not a widget: `CARD_WIDGETS` is the render
  order, the settings popover's switch list and the key set of `CardPrefs` all at once,
  and a fourth entry there would have grown a bogus switch and widened a type every
  consumer destructures. The agent-update row survives a fold, because folding is
  decluttering and not muting — a rarely-watched host is exactly the one whose agent
  goes stale unnoticed, and that row is the only place it says so.
- **A pane's scrollback is reachable whatever is running in it.** Reported as one pane
  scrolling with the wheel and another not, both running a coding agent under the same
  multiplexer. Neither was misbehaving: a program that turns on mouse tracking makes the
  terminal encode the wheel as a report for it and skip its own scrollback and cursor-key
  fallbacks outright, so from there the gesture means whatever that program decides. The
  pane that worked, worked *because* the wheel reached it — claiming the plain wheel
  would have fixed one by breaking the other, and taken the mouse from every full-screen
  program that uses it for menus or selection. So the plain wheel is untouched and Shift
  is the escape hatch, the way terminal emulators have settled this for years. On a
  multiplexer pane there is no local history to move, so a header control asks tmux for
  its own copy-mode and from there the ordinary wheel scrolls anything. The output sheet
  is backed by the same history instead of only the visible screen. The program in the
  pane is never sent a key: every alternative ended in typing into a live session, either
  a prefix the operator may have rebound or a PageUp the measured programs ignore.
- **A card says how much the machine is paging.** Swap sits under memory rather than at
  the end of the row, because it answers the question the line above it just raised, and
  it carries its own threshold — a shared 80% rule leaves a host that is already paging
  looking black, while lowering the general one turns healthy long-lived servers red and
  teaches people to ignore the colour. A host with swap turned off reports `0%`, not a
  dash: it answered, and a dash has to keep meaning nobody looked.
- **The agent finds binaries the way panes always have.** `exec` consulted `PATH` alone
  while a pane's multiplexer is resolved through the prefixes a service manager omits, so
  the same agent could run tmux for a terminal and report it missing for a command —
  measured on a Mac whose panes were attached to tmux sessions at that moment. launchd
  passes neither homebrew prefix; systemd drops what a user installed under their home.
  Agent 0.1.17 carries this, and macOS hosts need it before the new scroll control can
  reach tmux at all.

## 0.5.1

- **A terminal no longer dies just because nobody typed in it.** The browser's terminal
  socket carries every pane for one host and had no keepalive at all, while the agent's
  socket has been pinged every thirty seconds for as long as it has existed. A pane that
  is merely QUIET — one waiting on a coding agent's reply — sends nothing, and a CDN
  drops an idle WebSocket at around a hundred seconds. Measured on a live deployment: a
  socket closed on its own with code 1006, no close frame, after 125 seconds. The next
  keystroke then paid a reconnect that had to reattach every pane on that host, which
  from the chair is indistinguishable from a terminal that has simply gone slow. Both
  gateways now ping on the same interval and drop what stops answering.
- **A host stops paying for a usage reading it already has.** The coding-CLI budget
  gauge prefers what a CLI already wrote to disk and keeps spawning the CLI as a last
  resort. That last resort had quietly become the only resort — one vendor moved its
  state into a database and stopped writing the file, and a separate fix had made the
  spawn reliable enough to succeed every time. The result was a ~134 MB process started
  every sixty seconds, forever, to re-buy a number that moves on five-hour and weekly
  scales; on two hosts it stretched a heartbeat to between 2 and 10 seconds, all night.
  An answer is now served for fifteen minutes and an empty one backs off, so the cost
  falls from sixty spawns an hour to four, with nothing lost that a gauge could show.
- **When a terminal does feel slow, there is now something to read.** The agent times
  every socket write and every pane's wait for the shared send lock, and summarises them
  with its goroutine count, heap, open and cumulative pane counts and the host's load
  average. It says so out loud when a write, a lock wait, a collector or a whole pass
  crosses its threshold, and the server records each terminal socket's lifetime and
  close code. That is enough to tell "the agent is stalled" from "the server stopped
  reading" from "the host itself is paging" — three things that had been guessed at.
  The summary keeps quiet while it agrees with the baseline, so an ordinary day costs
  a line an hour rather than a hundred and twenty.

## 0.5.0

- **A commit's detail is three faces again — Commit, Changes and File tree — and each
  answers a different question.** The Commit face states who wrote it and what it
  touched, and a file row toggles its patch open underneath. The Changes face puts the
  changed files as a tree beside the chosen file's patch. The File tree face lists the
  **whole repository at that commit** and shows a file's **contents** rather than a
  patch — including files the commit never touched. An earlier build had folded these
  into two, on research that turned out to describe an older release of the tool being
  matched.
- **Reading a repository still writes nothing to it.** `ls-tree` joins the read-only
  whitelist on the same argument that let `ls-remote` in and keeps `fetch` out: it
  reads the object database and changes no ref, no index and no working tree —
  verified against a real checkout by hashing every file under `.git` before and
  after. Requires agent **0.1.11**; an older agent leaves the File tree face saying so
  rather than spinning.
- **Nothing is fetched until it is asked for.** Opening a commit costs its patch,
  opening the File tree face costs the listing, and opening a file costs that file.
  The browser caches all of it behind a ten-minute TTL and an eight-megabyte budget
  and drops the lot when the view closes. On the server the listing is stored per
  commit and pruned with it, while file CONTENTS never reach the object store at all —
  they are unbounded, one per path, and read once, so they live in a sixty-second
  buffer that spans the agent's answer and the browser's request.
- **A file's contents are syntax-highlighted**, chosen by extension rather than
  guessed from content, and that highlighting is the only markup that reaches the
  page: the source is escaped on the way through, and a file with no grammar takes the
  same escaping path.
- **The commit detail keeps one height and one shape.** Identity is pinned above a
  scrolling body instead of scrolling away with it, a long message folds to five
  lines, and switching faces no longer arrives with somebody else's file already open.
- Fixes: the phone's bottom navigation no longer appears on desktop (a stylesheet name
  collision), the commit list keeps its width when the branch panel opens, and a
  file's horizontal scrollbar sits on the pane rather than at the bottom of the file.

## 0.4.0

- **An AI CLI can now drive the whole fleet, not one machine.** Alongside the existing
  host key there is an **account token**, issued on the new **Coding CLI access** screen, at
  one of three permission levels — read-only, operate (register a host, mint its install
  command, update an agent, run commands) or admin (delete a host, roll an update across
  several). It expires, it is revocable, and every change it makes is in the audit log.
  Neither credential can create another credential; that line is the one worth reading
  twice, because a credential that could mint credentials turns one leak into a foothold
  that revoking the original does not close.
- **What a token may be granted is capped by what its owner may do, and that is
  recomputed on every authentication.** A token freezes the scope it was minted in; the
  person's standing in that scope is not frozen with it, so somebody removed from an
  organization stops carrying fleet-wide power within seconds rather than at expiry. A
  demotion weakens a token rather than revoking it — losing authority is often transient.
- **Two switches, because they answer different questions.** `mcpEnabled` is
  installation-wide and defaults ON so existing host keys keep working; the per-fleet
  `mcpUserTokens` decides whether that fleet accepts fleet-wide credentials at all and
  defaults OFF, because a capability with this blast radius must not arrive with an
  upgrade.
- **Destructive MCP tools describe before they act.** Without `confirm` they return what
  they would destroy and change nothing; `host_install_command` is gated only when a live
  enrollment code would be retired, and `run_command` is not gated at all, because a
  confirmation on every call is a rubber stamp a model learns to pass.
- **The sidebar says when an agent is behind, and updating starts there.** The mark
  appears only on hosts that have somewhere to go, says so in words rather than colour
  alone, and draws a different silhouette for each state. Pressing it opens a
  confirmation — no request is sent until you agree — and a job already in flight is not
  a button, so a second one cannot be started.
- **Fixed: a read-only host key could mint an enrollment code.** Minting retires the
  host's live code and yields an agent token that outlives the key that produced it, so
  it now needs a read-write key and the same confirmation the fleet surface always had.
  Host-mode MCP calls are audited too; they were not before.
- **Fixed: an echoed keystroke waited for the output coalescing window.** A remote
  terminal has no local echo, so a typed character only appears after a round trip —
  measured at ~55 ms on a real deployment — and the agent added the full flush interval
  on top of that while buffering a byte with nothing to coalesce it with. The first chunk
  after a quiet moment now goes out immediately; bursts still collapse into one frame per
  interval.
- **Fixed: Korean and every other multi-byte character typed as `____` inside tmux.** An
  agent started by launchd or systemd inherits no locale at all, so panes ran in the C
  locale and tmux, which reads exactly those variables to decide whether its client can
  render UTF-8, replaced each byte with an underscore. Panes now get an `LC_CTYPE` when
  the operator supplied none.
- **Fixed: the fleet-token list never showed a row.** It paged from zero against a
  one-based table, so the screen reported "no tokens yet" however many existed.
- **Fixed: a failed bookkeeping write could take the API down.** Recording that a
  credential was used was fire-and-forget with no rejection handler, and node's default
  for an unhandled rejection is to terminate.
- **`/mcp` has its own rate-limit bucket.** It shared the installation's, so a busy agent
  could push the dashboard into 429s.
- **A self-host compose file ships with the repository**, so the published images can be
  run without reading the source.

## 0.3.1

- **Published images are multi-architecture.** `ghcr.io/podosoft-dev/pdmux-{api,web}` now carry both
  `linux/amd64` and `linux/arm64`, so an Apple Silicon machine or a Graviton instance pulls a native
  image instead of failing with `no matching manifest`. The two are built on native runners and joined
  into one manifest list; the release job also verifies that both architectures' web images carry
  **byte-identical agent binaries**, since an agent checks its update against a sha256 the server
  hands out and a version number that meant different bytes on different servers would be worthless.

## 0.3.0

The first public release, and the first release whose number this file records — the tag line had
moved ahead of `version` in `package.json` (which is what the API reports to an agent), and 0.3.1
closes that gap. Everything below describes the product as of this release.

A self-hosted dashboard for operating several development machines from one
screen, with authentication, organisations, the audit log and the admin screens built on
[PodoKit](https://github.com/podosoft-dev/podokit).

### Product

- **Host registry** — hosts and services are added, edited, deleted, reordered and disabled from the
  screen. They are data belonging to an organisation rather than constants in a deployment script,
  and every change is recorded in the audit log.
- **The agent (a push model)** — `pdmux-agent`, installed on a host, opens an **outbound connection**
  to the server. Laptops, on-premises boxes and other clouds take part unchanged, with no inbound
  ports, no SSH key distribution, no tunnel and no VPN.
- **One-line install** — `curl -fsSL <origin>/install.sh | sh -s -- --code pdmxe_…`. The agent is a
  **static Go binary**, so the target machine needs no runtime and no compiler, and pdmux serves the
  binary and its checksums itself. The installer is rendered per request and **bakes its own origin
  and the sha256 of every artifact into the body** — it can be read before being piped, and there is
  no switch that turns checksums off. What rides on that line is a **single-use, 15-minute enrollment
  code**, not a long-lived token, and the code-for-token exchange happens **inside the binary**, so
  the token never passes through argv or a temporary file. The response that creates the host carries
  the code, so registration is a single operation.
- **Replacing the agent from the dashboard** — swap in a new build without logging into the host.
  There is one failure to defend against ("installing a build that cannot reach the server"), so the
  ordering is the design: the candidate is **actually executed before the swap** to confirm a
  handshake, the swap is `link`+`rename` (no window where the path points at nothing), and afterwards
  a **probation marker** makes it restore its own `.bak` if it cannot connect within the grace
  period. Restarting is `exit(0)`, so no extra privileges are needed, and a host with no supervisor is
  refused outright (`NO_RESTART_SOURCE`). A batch rollout **will not start** without a canary already
  running that build, and stops at three concurrent or two failures.
- **Terminal panel** — tabs or 2/4/9 splits, paging, zoom, swapping places by dragging the header, and
  retargeting (an existing session, a new session, a plain shell). Sessions survive a dropped
  connection, and the surface is **same-origin xterm.js**, so copying and key handling need no
  workarounds.
- **Resource trends** — current CPU/memory/disk and their recent trend on the card. A failed
  measurement shows as unknown rather than 0, and only the intervals past a threshold take colour.
- **Agent token budgets** — how much a coding agent running on the host has left, shown
  provider-neutrally. An unsupported window is not drawn at all, and a window that has already reset
  is discarded.
- **Read-only commit graph** — read the commit graph, branches and uncommitted work; clicking a commit
  fetches its patch then. The collector **does not fetch, gc or checkout** (not touching a working
  checkout is the premise).
- **Per-user personalisation** — split arrangements, card widgets and the default screen are stored on
  the account and open the same way on another device.
- **Degraded states are shown** — facts like no git, no multiplexer or a restricted PTY mode travel on
  the heartbeat and appear on the card.
- **Usable on phones and tablets** — a narrow screen (≤900 px) shows **one region at a time**, chosen
  from a bottom tab bar (servers / terminals / git). Switching is a visibility change, so sessions and
  scrollback stay alive, and each switch enters history so **Android's Back returns to the previous
  tab**. One terminal pane uses the whole screen **without disturbing the stored desktop split**, a
  tap raises the keyboard, and **Esc, Tab, Ctrl and the arrows — absent from a soft keyboard — are
  sent by a helper bar**. When the keyboard appears, the shell shrinks against `visualViewport` and
  the tab bar moves aside so the terminal is not covered. Controls are 44 px, inputs 16 px (blocking
  iOS auto-zoom), and widths down to **320 px** are guaranteed. **Korean, Japanese and Chinese input**
  is composed in the bottom input line and only the finished line is sent — a mobile IME cannot be
  trusted inside the terminal's hidden textarea (observed on a real device: `ㅎ ㅏ ㄴ`), so composition
  is received in a normal input field. On browsers that announce composition, the adapter also blocks
  the intermediate events.

### Packages (usable from other projects)

- `@pdmux/protocol` — the agent↔server contract (zod). **Additions only**, with the top-level key set
  frozen by a test.
- `@pdmux/core` — framework-free logic (terminal grid state, gauges, sparkline geometry, commit lane
  placement).
- `@pdmux/ui` — 15 Svelte 5 components. Data as props, behaviour as callbacks, strings injected — not
  bound to the app.

### Releases and versions

- **The agent ships as a static Go binary.** The target machine needs no language runtime and no
  compiler. `npm run build:agent` produces all four (linux·darwin × amd64·arm64) at once into
  `apps/web/static/agent/<version>/`, and the web image serves it verbatim — no object store, no
  second hostname, no credentials. The root `npm run build` **does not call** this script (CI machines
  have no Go toolchain, and there is no reason to turn a change that never touched the agent red).
- **There are two versions, and they deliberately move apart.** pdmux itself uses the repository
  SemVer (the root `package.json`) and the agent has its own
  (`agent/internal/cli/version.go`), which is raised only when `agent/**` or `packages/protocol/**`
  changes. This stops a web-only release from painting every host "needs update" and handing them a
  **byte-identical binary**.
- A release ships `manifest.json` (version, per-platform sha256, byte counts) together with
  `SHA256SUMS` (in `sha256sum -c` format, so a person can verify it by hand). Builds are reproducible
  — `-trimpath` removes the build machine's paths and `-buildvcs=false` removes the commit id and the
  repository's dirty flag, so identical sources give an identical sha256 (if editing one line of the
  README changed the agent's hash, every host would re-download the same bytes).
- CI enforces two things. It fails if the agent or the contract changed while `AgentVersion` did not,
  and it fails if the built linux/amd64 binary's `--version` differs from the version in
  `manifest.json`. The second is not a hypothetical — while `AgentVersion` was a `const`, the linker's
  `-X` **silently did nothing**.
- A running pdmux shows its version **under the account menu** and tells agents about it as
  `welcome.serverVersion` (advisory — not a gate).

The full rules (what moves which number, what `PROTOCOL_VERSION`, `MIN_SUPPORTED_AGENT` and its `-0`
do, and the two CI checks): [`docs/VERSIONING.md`](docs/VERSIONING.md).

#### Agent release history

Recorded separately because it moves independently of the repository version.

| Agent | What it was |
|---|---|
| **0.1.7** | A correction, not a feature. Eight commits had changed the agent's non-test source since 0.1.6 was published without the version moving, so the committed `SHA256SUMS` described a binary nobody was serving and two hosts running byte-different builds both read `current` on the dashboard — the verdict compares version strings. ⚠ **0.1.6's committed checksums do not match what a build of that source produces**, and that entry is left as the record of what was built at the time rather than rewritten to claim bytes that were never published under it. The CI gate that should have caught this ran on pull requests only, and this repository commits directly to main; it now runs on both. |
| **0.1.1** | The build that first exercised the remote-update path on two real hosts. 0.1.0 → 0.1.1 took **under 10 seconds** from `restarting` to `done`, the host was never shown offline during it, and a host holding 20 tmux sessions kept all of them. A **downgrade attempted on the same host was refused with `NOT_NEWER`**, leaving both the installed binary and the `.bak` untouched. |
| **0.1.0** | The first agent rewritten in Go. The `script(1)` fallback and the "cannot resize on macOS" limitation disappeared here (`creack/pty`). |

### Verification

- **393 unit tests** (protocol 26 · core 69 · ui 49 · api 81 · agent 140 · web 28), all passing.
- Mobile e2e — **17 tests** in a separate Playwright project (Blink by default; WebKit is opt-in with
  `PDMUX_WEBKIT=1`). Two layout regressions (a 0 px terminal, and the desktop grid surviving on a
  phone) are locked down with measured values.
- Playwright e2e — every pdmux spec passes (including a real PTY round trip and rendering a commit
  patch); 149 in the whole suite.
- Requirement traceability: **all 203 TCs ✅**, with zero errors from the checker.
- The generalisation audit passes — none of the original tool's proper nouns are in the source.

### Known limitations

- Terminal relaying assumes a single process (multiple replicas would need a Redis hop in front of
  `sendToHost`).
- Remote update's **probation marker only protects hosts whose installed binary already knows how to
  read the marker.** The **first update** away from a build predating that feature is protected by
  "verify before swapping" alone — which is why there are two gates.
- `sha256` only stops **a corrupted or swapped static object**; it does not stop a compromised pdmux
  (the side declaring the hash and the side serving the bytes are the same server). A signature was
  left out rather than half-done, and adding one later is an addition.
- Putting a **browser-oriented authentication gateway** (an identity-aware proxy) in front means **the
  agent cannot dial that public name** — give the agent paths a bypass or service-token policy, or use
  a private address ([`docs/OPERATIONS.md`](docs/OPERATIONS.md) §2-2).
- Repositories are identified by their path string, so moving a checkout rebuilds the detail cache
  (not a correctness problem).
- The dashboard refreshes by polling (the server already publishes SSE, so switching is follow-up
  work).
- Automated testing on the iOS engine (WebKit) is opt-in — running it needs about twenty system
  libraries, and above all **no headless engine can produce a soft keyboard**. That part is covered by
  a procedure a person follows on a real device. Firefox Android is checked manually because
  Playwright offers no mobile emulation for it.
- Foldable cover screens (~280 px) are best-effort. The guaranteed floor is 320 px.
- **On a phone, composed characters (Korean, Japanese, Chinese) are line-at-a-time** — typing them one
  character at a time into the terminal, and entering them one character at a time into a full-screen
  TUI, are not supported. iOS reports no composition signal whatsoever (confirmed in a real-device
  log), so receiving composition in an input line is the only reliable approach. The evidence and the
  alternatives considered: [`docs/IME_INPUT.md`](docs/IME_INPUT.md).
