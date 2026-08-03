# Operations guide

What you need to actually run pdmux — deployment, agent onboarding, retention, backups and
incident response.

---

## 1. Deployment shape

| Piece | Minimum | Recommended |
|---|---|---|
| API + web | two containers | behind a gateway (Traefik/Nginx), serving `/api` and `/` (web) on the **same origin** |
| PostgreSQL | 1 | a managed instance with automatic backups |
| Redis | 1 | shared by sessions, rate limits and job queues |
| Object storage | MinIO | any S3-compatible service (stores commit patch bodies) |

**Why the same origin matters**: the terminal connects from the browser to `/terminal/ws`. Putting
web and API on different domains makes cookies, CORS and the WebSocket upgrade all special cases,
and takes you back to the cross-origin traps an earlier tool ran into.

**Start the web container with `npm start -w pdmux-web` (= `node server.js`)** — starting it with
`node build` (adapter-node's default entry point) leaves HTTP fine but **kills terminals only**:
the upgrade goes into SvelteKit, becomes a 303, and panes stay permanently "reconnecting". This
entry point is the adapter-node server (same port, graceful shutdown and `IDLE_TIMEOUT` contract)
plus relaying of the `/terminal/ws` upgrade, targeting `BACKEND_INTERNAL_URL`.

**The gateway in front needs no special rule for terminals** — just pass `Upgrade`/`Connection`
headers through (satisfied by Traefik's defaults and Nginx with `proxy_http_version 1.1`). The path
the app forwards is **restricted to exactly one** (`TERMINAL_WS_PATH`) and every other upgrade is
closed, so a permissive gateway does not open the API's internal surface.

### 1-1. ⚠ `vite dev` is not a serving path

The table above is **the whole serving shape** — what reaches users is **a container holding the
built app**. The vite dev server that `npm run dev` starts is **a development tool**, not something
to serve to people.

This is not taste; the properties differ:

| | `vite dev` | container (build output) |
|---|---|---|
| one page load | **about 293** module requests | **around 10** |
| asset names | `?v=` and chunk names **move** on every re-optimise | content-fingerprinted, so they **do not move** |
| cache policy | revalidation is right in dev | fingerprints make **`immutable`** right |
| blast radius | **one** of 293 being stale or caught by an auth gateway kills hydration | not applicable |

⚠ **Putting a dev server on a public URL hands those properties straight to people.** That
happened: on a phone the screen "appeared briefly and then 500'd", and no server-side action
reached it. The table above is the whole of the reason.

If you must check something from a phone during development, do it **knowing that**; it does not
make it a deployment shape. From the moment a release is in someone's hands it is the container in
the table above.

---

## 2. Agent onboarding

### 2-0. What a person does and what AI does

**A person** creates the host. From there, a coding CLI running on that machine can do the rest
without opening the pdmux repository — read host state, fetch the install command, run commands.
Connecting it is §2-3; the contract is [`CONTRACTS.md`](CONTRACTS.md) C6-2.

### 2-1. The normal path — one line

1. Create the host in the UI (label, address, tags, service list). **The response that creates the
   host carries the enrollment code with it** — there is no separate step to issue a code
   afterwards. The dialog gives you a command to paste as-is.

   **Who may create one** depends on which fleet it is. In a **personal fleet** (a session with no
   active organisation — the `personal:<userId>` scope) **the user themselves** creates it. They are
   registering their own machine into their own scope, and that scope contains nobody else. An
   **organisation fleet** is shared, so as before **only administrators** change it — a member
   deleting a host or revoking a token changes the screen of a colleague working on that machine
   right now.

2. On the target machine:

```bash
curl -fsSL https://pdmux.example.com/install.sh | sh -s -- --code pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW
```

Adding `--user` installs it as a per-user service in the home directory with no root. For a system
install, pipe into `sudo sh` (the script **does not call sudo itself** — that decision belongs to
the operator, and building the command line for them would mean printing the code to the screen
again).

Two things make that one line possible, and both are properties to protect.

- **The agent is one static Go binary.** No language runtime, no compiler on the target. The binary
  and its checksums are served **by pdmux itself** at `/agent/<version>/…` — no object store, no
  second hostname, no credentials.
- **`/install.sh` is not a static file; it is rendered per request.** It bakes its own origin, the
  version being published and **the sha256 of every artifact** into the body. So it can be read
  before being piped, and there is no way to turn checksums off — verification you can turn off gets
  turned off eventually, in somebody's Ansible role.

**An enrollment code (`pdmxe_…`) and a host token (`pdmux_…`) are different things.** The code is
**single-use, 15 minutes, one per host**, and that one line gets pasted into chat, lands in shell
history and gets photographed off a screen — if a long-lived token made that journey, every copy
would be a permanent fleet credential. The code dies in minutes. The answer to an expiry or a typo
is one press of **Regenerate**, and issuing a new code revokes that host's old one in the same call.

**The exchange happens inside the binary, not in the script.** Everything the shell holds is visible
to other accounts on that machine (argv in `ps`, temporary files). Had the script done the POST, it
would have to scrape the token out of the response and hand it back to the binary, and the thing
making that journey would be **a long-lived credential**. The token's path today is exactly one:
HTTPS response body → the process → **a 0600 configuration file**.

After installing, the script runs `pdmux-agent doctor` to confirm **an actual handshake**, and exits
7 on failure. An installation that writes files and declares success proves nothing except that
files were written.

### 2-1-1. When a host was created under the wrong account

Registration happens as whichever account was logged in. If there is one machine and you picked the
wrong account, **do not register again** — use **move to another account** on the host detail page
to correct the owner only.

```
POST /hosts/:id/move   { "targetEmail": "…" }
```

- **The agent keeps running.** No reinstall, no token reissue, and the socket is not dropped — tokens,
  services, repositories and metrics all hang off the host row and move with it.
- ⚠ **It is refused with a 409 if the target account already has that label.** Having already
  registered a duplicate is exactly this situation, so **first delete or rename the empty one** (zero
  tokens, never connected) and then move.
- You can only move hosts in your own scope. Somebody else's host is a 404.
- It is recorded in the audit log as `host.move`, together with the address it went to.

### 2-2. ⚠ A browser-oriented auth gateway in front will block the agent

If an access policy sits in front of the public dashboard domain, non-browser clients get **a login
page** back. The agent reads that as a failed handshake, and `/install.sh` receives HTML instead of a
shell script. The symptom reads as "the installer is broken", so suspect this first.

Do one of two things.

- Give `/install.sh`, `/agent/*` (release artifacts) and `/agent/ws` (the agent socket) a **bypass or
  service-token policy**. These paths have to answer anonymously anyway, which is why they are in the
  app's public path list too.
- Or let the host reach pdmux on a **private address** and pass that address with `--server`.

One related thing: **the install script's origin comes from the request headers, and the scheme is
decided by how that host looks.** Behind a proxy `x-forwarded-proto` is authoritative; reached
directly with no such header (loopback, private range) it is `http`, and a public name gives `https`.
Assuming https bakes **an unusable URL into the script**, and the very next thing that script does is
fetch a binary from that URL (observed symptom: `SSL routines::wrong version number`). Check that the
reverse proxy sets `X-Forwarded-Host`/`X-Forwarded-Proto` to **the name operators actually use**, and
state it explicitly with `--server` when an exception is needed.

### 2-3. The agent is a service — a remote update is "exit and be restarted"

The installer writes a systemd unit (Linux) or a launchd plist (macOS) with `Restart=always` /
`KeepAlive`. That fact is **the premise of remote update**: triggering an update from the dashboard
makes the agent fetch a new binary, verify it, swap it and **`exit(0)`**, and the service manager does
the rest. So the agent needs neither extra privileges nor a service-manager client.

Three operational consequences follow:

- **With no supervisor the update is refused** (`NO_RESTART_SOURCE`). For an agent installed with
  `--no-service` or started by hand in a terminal, exiting is a hole it cannot come back out of, so
  refusing is more honest than trying.
- **The unit carries `StartLimitIntervalSec=0`.** With the default rate limit, a few minutes of server
  downtime lets restarts exceed the limit, the unit collapses into `failed`, and even after the server
  returns that host stays offline forever until somebody goes and runs `systemctl reset-failed`.
- **A restart kills shell panes.** Multiplexer sessions survive and reattach; `shell`-target panes and
  whatever was running in them end. That is why the confirmation dialog shows both numbers up front.

### 2-4. Air-gapped and manual installs (`--token`)

A machine that cannot reach pdmux, or where you have decided not to execute `/install.sh`, is
installed with a **long-lived token**. Issue one from the host detail page — the plaintext is shown
**once, on that screen** (the server keeps only a hash). A person moves the binary.

```bash
# verify the transferred binary (SHA256SUMS is in `sha256sum -c` format) and install it
sha256sum -c SHA256SUMS --ignore-missing
sudo install -m 755 pdmux-agent-linux-amd64 /usr/local/bin/pdmux-agent
sudo pdmux-agent install --server https://pdmux.example.com --token pdmux_xxx
sudo systemctl daemon-reload && sudo systemctl enable --now pdmux-agent.service
pdmux-agent doctor          # configuration, tools, PTY and a real handshake
```

**A zero-downtime token change is: issue a new token → update the agent's configuration
(`pdmux-agent install --token …` then restart) → revoke the old token.** Follow that order and there
is no connection using the old token at revocation time, so nothing drops.

> ⚠ **Revocation now closes a live connection immediately.**
> `POST /hosts/:id/tokens/:tokenId/revoke` closes sockets accepted with that credential using
> `4003 agent token revoked` (only connections made with that token — if the same host is connected
> with another valid token, that agent stays). Previously it blocked only the *next* connection, so a
> socket opened with a leaked key stayed alive for days.
>
> ⚠ **The "rotate" button is not zero-downtime.** Rotation issues a new token and **revokes the old
> one** in one call, so the running agent is dropped, retries with the old secret and is refused with
> 401 — that host is offline until the new plaintext is installed on that machine. This makes visible
> the outage rotation always caused (the old secret was invalid immediately, and the agent only found
> out at its next reconnect). When you need zero downtime, use the three steps above instead. Rotation
> is the right tool for **responding to a leak** (cut that credential now and take a new one).

### 2-5. Common to both

After installation, collection intervals, git roots and probe targets are changed **on the server**
(no reinstall). The moment you save, **a `config` frame is dispatched per host to connected agents**,
and the agent re-tunes its timers, collectors and probe list on the spot with no reconnect. A host
that was off at that moment receives the same configuration in the `welcome` of its next connection
(nothing is queued).

**Disabling a host also drops the agent that is attached right now.** The card's toggle (or
`PUT /hosts/:id/enabled`, `PATCH /hosts/:id {"enabled":false}`) closes that host's socket with
`4002 host disabled` and refuses later attempts with 403 — if you switched it off to stop the machine,
it actually stops (previously only the next connection was refused, so the card kept updating after
you turned it off). **Tokens are not revoked**: switch it back on and the agent reconnects on its own
backoff and attaches as before (no reinstall, no reissue, nothing to do on that machine). Terminal
panes that were open lose their connection and have to be reopened.

**Deleting a host is irreversible. And it also drops the attached agent.** `DELETE /hosts/:id` takes
**that host's tokens, enrollment codes, services and commit metadata** with the row
(`onDelete: CASCADE`) and closes the socket with `4004 host deleted`. The different code from
disabling is exactly the difference between the two operations — disabling keeps the tokens so one
toggle brings the same agent back, while **deleting takes the tokens too, so the agent still sitting
on that machine is refused forever.**

> **If you deleted one by accident** — the agent is still installed on that machine, looping through
> restarts and receiving `401`. Recovery is not a toggle but **re-registration**:
>
> 1. **Register the host again** (add a card / `POST /hosts`). **The id is new** — the resource
>    samples, commit metadata and layout placements accumulated under the old id were deleted with it
>    and are not coming back (short of restoring the database from a backup; §4). The label can be
>    reused as-is.
> 2. Use the **enrollment code** from the registration response (15 minutes) to bind that machine's
>    configuration to the new host — `sudo pdmux-agent install --server <origin> --code pdmxe_…` and
>    restart the service (`sudo systemctl restart pdmux-agent.service`, or
>    `systemctl --user restart …` for a per-user install). **The binary does not need re-downloading**
>    — `install` only rewrites the configuration file and the unit. If air-gapped, issue a token and
>    swap it in with `install --token` as in §2-4. Finish with `pdmux-agent doctor` to confirm the
>    handshake.
> 3. The card starts filling again. **Metrics and commit details accumulate from scratch** (the agent
>    re-collects within its budget).
>
> If you only meant to stop it for a while, the answer is **disable, not delete** (paragraph above).
> That one comes back for free.

**Security posture**

- A token's scope is one host. On a leak, revoke that host only — and revocation **terminates
  connections opened with that token immediately**.
- Enrollment codes are single-use, 15 minutes, and at most one is alive per host (enforced by a
  partial unique index).
- The enrollment endpoint has to be public (a machine mid-install has no session). So it is rate
  limited to **10 per minute per address** and the code space is 100 bits — in that combination,
  guessing is not a search, it is a queue.
- A bad code answers with **the same 401** whether it was malformed, unknown, expired, already spent
  or revoked. Distinguishing them turns it into an oracle that says "this code exists, it is merely
  expired". An operator sees the real reason at `GET /hosts/:id/enrollments/current`.
- The agent opens no inbound port. No firewall rule to add.
- Host registration, code issue/revoke/consume, token issue/revoke, opening a terminal and agent
  updates are all recorded in the audit log (`/admin/audit`). **Neither codes nor tokens go into audit
  entries.**
- The agent's logs mask tokens.

### 2-6. Attaching an AI CLI — the hosted MCP endpoint

From **Coding CLI access** on the host detail page, issue an API key scoped to that host and copy the
configuration for your CLI. There is one endpoint: `https://pdmux.example.com/mcp`.

```
Codex   codex mcp add pdmux --url <origin>/mcp --bearer-token-env-var PDMUX_MCP_KEY
Claude  {"mcpServers":{"pdmux":{"type":"http","url":"<origin>/mcp",
          "headers":{"Authorization":"Bearer ${PDMUX_MCP_KEY}"}}}}
```

⚠ **The copied configuration contains no plaintext key.** Only the environment variable's name goes
in — a configuration block is the thing on this screen most likely to be committed to a repository,
and a secret riding in one leaks structurally. The plaintext is shown once, right after issue, and the
server keeps only a hash.

**A key's scope is one host.** No tool takes a host id, so there is no way to name another machine,
and **there is no tool that creates a host** — with one, the credential would widen its own scope. A
read-only key refuses `run_command`. Revocation and expiry take effect immediately.

| Tool | What it does |
|---|---|
| `host_detail` | what this host is, whether the agent attached, and what it can do |
| `host_metrics`, `host_sessions`, `host_services`, `host_usage`, `host_repos` | reads |
| `host_install_command` | issues a fresh enrollment code and gives **one line to run** (it does not run it) |
| `run_command` | runs one command and returns the exit code |

**MCP does not run the install command for you.** That means a shell on the target machine, and that
shell belongs to the person sitting in front of it. The tool hands over a line to paste.

The **skill bundle** (`GET /agent-kit`) is documentation telling a CLI in what order to use these
tools. The manifest carries a sha256 alongside it, and the installer writes only inside
`.claude/skills` and `.agents/skills` — it **does not touch a root `AGENTS.md` or `CLAUDE.md`**.

---

## 3. Retention and capacity

| Data | Default retention | Adjusting it |
|---|---|---|
| resource samples | 7 days (30-second interval) | admin settings → a cleanup job deletes periodically |
| commit metadata | a window per repository (300 commits by default) | anything outside the window is cleanup fodder |
| commit patch bodies | the same lifetime as the metadata | object storage; deleted with the metadata |
| audit log | indefinite (recommendation: archive per your policy) | admin settings |

A sense of size (estimated from measurements): a commit patch averages around 24 KB. Two hosts × 15
repositories × a 300 window is **about 100 MB**. Resource samples are 2,880 rows per host per day —
negligible at 7 days' retention.

Watch the collection budget alongside it: building 15 repositories × 300 commits at once on a cold
start stalls the loop, so it fills newest-first within **a per-pass budget** (120 by default). The
screen shows what remains as "still collecting (N)".

---

## 4. Backup and recovery

- **PostgreSQL is the source of truth** (organisations, users, hosts, services, layouts, commit
  metadata, audit log). Regular dumps are mandatory.
- **Object storage is reproducible** — losing it means the agent rebuilds it (details read "collecting"
  meanwhile).
- **Redis is cache and queues.** Losing it drops sessions and empties queues; it is not a recovery
  target.
- **Keep `BETTER_AUTH_SECRET` with the backup.** Settings encrypted in the database (OAuth secrets,
  SMTP passwords) are unlocked with it. Lose it and those values cannot be decrypted.

Recovery: restore the database → confirm migrations → start API and web → agents **reconnect
automatically** and cards fill within minutes (if storage was empty, details rebuild progressively).

---

## 5. Common states

| Symptom | Where to look first |
|---|---|
| a card says "offline" | **whether the host was disabled** (in that state the server drops and refuses connections — just toggle it back on) · whether the token was revoked or rotated (`4003` or 401 in the agent log) · the agent process · the outbound firewall. `pdmux-agent doctor` |
| no card at all, but that machine's agent keeps restarting | **the host was deleted.** That machine's log shows one `4004 host deleted` followed by nothing but 401 (403 would mean disabled, not deleted). There is no toggle to undo it — **re-register**; see §2-5 |
| values show only `—` | that metric could not be measured (a failed measurement is null, not 0). Check the agent log |
| no token-budget row | that provider does not report that window, or the snapshot expired (a past reset is discarded). ⚠ The CLI may also have changed its format — the procedure for finding it again is [`USAGE-COLLECTION.md`](USAGE-COLLECTION.md) §4 |
| budgets appear but the host suddenly slows down | **the fallback may be running.** When the cheap path fails it pays in resources instead of data — `pgrep -P "$(pgrep -f 'pdmux-agent run')"` should be empty. [`USAGE-COLLECTION.md`](USAGE-COLLECTION.md) §3 |
| clicking an old commit says "collecting" | normal — it fills newest-first within the budget and will be filled on a later pass |
| remote branches are stale | normal — the collector **does not fetch** (not touching a working checkout is the premise) |
| a terminal is black | the session expired: log in again and reopen. Check the relay's refusal reason in the log |
| `shell` opens but `session` does not | **the multiplexer was not found.** The agent runs under a service manager whose PATH is a few system directories, so something installed by hand with a package manager is invisible. It now also searches user and package-manager locations, so **upgrading to an agent with that fix resolves it**. Check it in the service's own environment: the `tmux` line of `env -i HOME="$HOME" PATH=/usr/bin:/bin pdmux-agent doctor` |
| `mux.missing` on the card, the picker offers no sessions | that host **genuinely has no multiplexer**. Installing one is the host owner's decision, so the product does not install it — install it and session targets return at the next heartbeat; until then `shell` is the answer (it ends with the connection) |
| `terminal limit reached (16)` in a pane | the agent's **concurrent PTY cap** (a guard protecting the host, `MAX_TERMINALS`). One screen tried to open more than 16, so reduce the pane count in the layout — this was the classic symptom back when the first screen auto-attached to all of a host's sessions (measured: `s15`–`s17` refused, 43 times in a day). If you genuinely need more, raise it with an agent option |
| `curl … /install.sh \| sh` ends silently | an auth gateway (§2-2) returned HTML, or that deployment has no published release. Run `curl -fsSL …/install.sh` **without the pipe and read the body** — even with nothing to install, a script comes back with 200 stating why (`curl -f` prints nothing on 4xx/5xx) |
| `SSL routines::wrong version number` during install | the scheme of the origin baked into the script differs from reality (§2-2). Check the proxy's `X-Forwarded-Proto`/`X-Forwarded-Host`, or state it with `--server` |
| every Agent column reads `unknown` | **no build is published for that platform.** Check that `npm run build:agent`'s output made it into the web image, and — in a split-image deployment — that the API sees the same tree via `AGENT_RELEASE_DIR` |
| the update button gives `NO_RESTART_SOURCE` | that host has no supervisor (§2-3) — a `--no-service` install, or an agent started by hand |
| an update ends `rolled back` | the new build did not complete a handshake within the grace period. The old binary was restored and is running, so **the host is fine**. The cause is in that build |
| **Listening ports** on the host detail page is empty | ⚠ **three situations produce a similar screen, and the screen distinguishes all three.** ① An agent from before this feature **reported nothing at all** (the screen says the agent is too old), and updating fills it. ② With a `listeners.unavailable` diagnostic, there is **no way to read them on that host**. ③ Neither of those means **there genuinely are no open ports**. Read the wording and the diagnostic first |
| a port you just opened is not listed | ① this list is **cached for 60 seconds** (querying it every heartbeat makes measuring cost more than what is measured — [`USAGE-COLLECTION.md`](USAGE-COLLECTION.md) §1). Wait one cycle. ② **A port already registered as a service is excluded from this table** — it is in the services table above. ③ It may be classified as a system or ephemeral port and folded away — expand "show N system and ephemeral ports" |
| `listeners.truncated` on the list | more ports are open than the contract carries. The overflow is **truncated** rather than dropped — without truncating, the whole heartbeat would be refused and the resource bars and session list would disappear with it. The diagnostic says how many were left out |
| refreshing still shows the old screen | check whether a cache header attached to the feed response (it must be `no-store`) |
| Korean on a phone comes apart into letters | within expected behaviour — on a phone, composed text is written into the **input line** below the terminal and sent with Send. Why, and the limits: [`IME_INPUT.md`](IME_INPUT.md) |

---

## 6. Upgrading

- **The server**: migrate, then replace the containers. The protocol is additive, so **older agents
  keep connecting**. Pushing a release tag makes CI build both images, and a person approves the plan
  before it rolls out. There is a separate path for pushing local build output into a running container
  to check something during development, and that is **not a release** — the image tag is unchanged, so
  the deployment runs code that differs from its tag, and the status query reports that fact.
- **The agent**: the card's Agent column says which hosts are behind, and replacing them is done **from
  the dashboard** — no logging into the host. Roll one at a time (row menu → Update agent) or in a
  batch, and a batch **will not even start** without a canary already running that build, stopping at
  three concurrent or two failures. Each agent verifies the candidate before swapping and **rolls itself
  back** if it cannot connect within the grace period after.
  Release artifacts are produced by `npm run build:agent` and served by the web image. **If the API and
  web are deployed as separate images**, the API side must be given the same tree via
  `AGENT_RELEASE_DIR` — otherwise the server sees "no published build" and every host reads `unknown`.
  The two version lines and the CI checks: [`VERSIONING.md`](VERSIONING.md).
- **PodoKit**: `podo update` merges template improvements. `owned` files are untouched and only the
  fenced regions of `assembled` files are recomputed — edits elsewhere stay.
