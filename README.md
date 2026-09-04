# pdmux

A self-hosted dashboard for running several AI CLIs — Codex, Claude and friends — side by side in
one browser tab.

[한국어 README](README-ko.md)

![The pdmux dashboard: host cards on the left, two terminals in the middle, a commit graph on the right](docs/media/dashboard.png)

## Why it exists

You spend a lot of time waiting on an AI CLI, so you end up running several at once. That is where
it gets awkward.

A terminal shows you one thing at a time. Watching several means setting up tmux or terminal splits
yourself, then moving between windows and remembering which one was doing what. The more work you
have in flight, the more that setup and that remembering cost you.

**I wanted to see all of them at once in a browser, and drop into one only when it needed me.** That
is where pdmux started.

The rest was added because it came up while actually using it.

- **Resource monitoring.** Run a few AI CLIs and your machine's CPU, memory, swap and disk are the first
  things to give out. Watching only the terminals tells you nothing about why everything suddenly got
  slow, so host state sits on the same screen.
- **Token budgets.** The other common reason work stops is running out of tokens. Remaining usage for
  Codex and Claude is on the card, so you find out before you hit the wall rather than after.
- **Git changes.** What an AI CLI produces is ultimately commits. Seeing what changed, and how far
  each branch has been merged, belongs in the same browser — hence the read-only commit graph.

It was built for one machine, but nothing changes when there are more. Add a host and you get one
more card, and that host becomes selectable in the terminal grid.

## What you see

**Terminals.** Lay them out as a single pane, or 2/4/9 splits. Each pane picks its own host and
session, so one screen can show several different jobs at once. Click an inactive pane to make it
the input target, drag a header to swap two panes, or use the header action to zoom one explicitly.
The focused and zoomed states are labelled in the pane header instead of covering terminal output.

Sessions live in a multiplexer (tmux) on the host. Close the browser and the AI CLI keeps running;
open it again and you reattach to the same session. The split layout and which pane held which
session are stored on your account, so the same screen opens on another computer.

**Host cards.** Current CPU, memory, swap and disk plus a sparkline of the recent trend. A measurement that
failed shows as `—`, not `0`, because `0` reads as "healthy but idle".

**Token budgets.** Remaining usage per provider, per window (5 hours, 7 days). Providers disagree
about which way round to report it — some send what is left, some what was spent — and the card
always draws what is left. A window a provider does not report is left out rather than drawn as an
empty gauge.

**Commit graph.** Branches, tags and uncommitted changes, with a commit's diff fetched when you click
it. The right-hand panel groups local, remote and tags, and marks each branch with `↑n ↓n` for how
far it has diverged. Diverged branches sort to the top, and a branch whose upstream has disappeared
gets its own badge.

The collector is **read-only**. `fetch`, `gc` and `checkout` do not appear in the code at all, and
every git call carries `GIT_OPTIONAL_LOCKS=0` so even `git status` leaves the index alone — not
disturbing a checkout you are working in is the premise. The trade is that remote branches are as of
your last fetch, and the panel says so.

**Services and external access.** Register the services a host exposes (port, probe type, URL) and
the agent probes them on each heartbeat. Card shortcuts are opt-in per host and start hidden: a
loopback or LAN URL is usually useful only on the same network. When a service must be reachable
elsewhere, an administrator can publish its HTTP or HTTPS port through Cloudflare Tunnel, protected
by a reusable Cloudflare Access policy by default. Public access is an explicit, separately
confirmed mode. Raw TCP forwarding is not included.

## How it works

```
browser ──── HTTPS / WebSocket ────▶ pdmux ◀──── WebSocket (outbound) ──── agent (one per host)
                                      │
                                      ├─ Database      PostgreSQL on a server, SQLite on desktop
                                      ├─ Cache/events  Redis on a server, in-process memory on desktop
                                      └─ Objects/jobs  S3 + BullMQ on a server, local files + jobs on desktop
```

Each host runs one agent: a single static Go binary that opens one **outbound** WebSocket and does
everything over it. Heartbeats, PTYs, git snapshots and service probes all share that connection.

The direction is practical. Had the server connected inwards, you would need the same network, SSH
keys distributed everywhere and inbound ports open. One outbound connection means an office desktop,
a laptop at home and a cloud VM all attach the same way, NAT or no NAT.

Terminals use that connection too. The agent opens a PTY on the host, the server relays a WebSocket,
and the browser draws xterm.js **from the same origin**. No separate terminal server, no tunnel, and
copy, paste and key handling stay inside our own code.

Collection intervals, git roots and probe targets are server-side configuration. Saving pushes the
change straight down to connected agents, so you never go back onto a host to adjust them.

Upgrading the agent is done from the dashboard as well. There is exactly one failure to defend
against: **installing a build that cannot reach the server** — after which the button that would undo
it is on the screen that host just vanished from. So before swapping, the running agent executes the
candidate binary and makes it complete a real handshake; after swapping it stays on probation and
restores the previous binary if it cannot connect in time. The details are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2-1.

## Installing it

Everything is a published image, so the machine needs Docker and nothing else — no Node, no Go, not
this repository. `linux/amd64` and `linux/arm64` are both published, so an Apple Silicon box or a
Graviton instance pulls a native image.

```bash
base=https://raw.githubusercontent.com/podosoft-dev/pdmux/main/infra/docker
curl -fsSLO "$base/selfhost.compose.yml"
curl -fsSL  "$base/selfhost.env.example" -o .env
$EDITOR .env        # the domain, your email, and the four secrets it asks for
docker compose -f selfhost.compose.yml --env-file .env up -d
```

Open `https://<your domain>` and register. **Sign up with the address you put in `ADMIN_EMAILS`** —
that is what makes an account an administrator, and an account that registers with any other address
is an ordinary user with no sign on screen saying why. HTTPS is not a preference here: session cookies and agent tokens ride on it, and the
install command a host runs bakes in whatever origin the gateway reports. So the compose file
includes Caddy, which obtains and renews the certificate on its own.

Retention, backups, or putting your own gateway in front of this one instead:
[docs/OPERATIONS.md](docs/OPERATIONS.md) §1.

### Desktop application

pdmux can also run as a self-contained desktop application on macOS, Windows, and Linux. It uses the
same API and SvelteKit application as the server edition, but selects SQLite, an in-process cache and
event bus, a local object directory, and an in-process job runner. PostgreSQL, Redis, and S3 are not
required. The Electron shell owns process startup, loopback-only ports, tray behavior, backups,
certificate-pinned remote mode, and updates; product screens are not forked.

Desktop installers are produced by the repository's GitHub Actions workflow. Build instructions,
data locations, backup behavior, and remote-mode configuration are in
[docs/DESKTOP.md](docs/DESKTOP.md).

For upgrades, pin the new release in `PDMUX_VERSION`, pull the images, and let the one-shot migration
finish before the application containers roll. Existing installations must skip `0.11.0` and use
`0.11.1` or later; see [the upgrade procedure](docs/OPERATIONS.md#1-2-upgrading-published-images).

## Adding a host

Add a host in the UI and it hands you the install command with an enrollment code already in it:

```bash
curl -fsSL https://<your-pdmux>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
```

Nothing has to be installed on the target first — no runtime, no compiler. The code is single-use and
expires in 15 minutes, and the long-lived token is exchanged inside the binary straight into a 0600
file, so it never reaches your shell history or `ps`. `--user` installs a per-user service without
root; a machine with no route out takes a token instead
([docs/OPERATIONS.md](docs/OPERATIONS.md) §2-4).

If the host has tmux, its sessions show up immediately. If not, you can still open a plain shell, and
the card says so.

### Publishing a host service

Connect Cloudflare from **Fleet settings** with a scoped API token, then open a host's service menu
and choose **Set up external access**. pdmux suggests a `service-host.base-domain` hostname, but you
can edit it before saving. It creates one remotely managed tunnel per host and attaches each service
to that host's ingress configuration.

The host agent downloads the matching official `cloudflared` release into its private state
directory, verifies the release digest, and keeps the previous executable for rollback. It does not
install a system package or service. The tunnel token is encrypted in PostgreSQL, sent only in the
agent configuration, and passed to `cloudflared` through its environment rather than argv.

See [the Cloudflare setup and recovery guide](docs/OPERATIONS.md#2-7-publishing-http-services-with-cloudflare-tunnel)
for token permissions, cleanup order and failure states.

### Without any machines

`tools/demo-agent.mjs` speaks the agent side of the protocol, so you can fill a dashboard with no
hosts at all. It runs from a checkout of this repository: add a host in the UI, mint a token on its
detail page, then run:

```bash
bun tools/demo-agent.mjs --server https://<your-pdmux> --token pdmux_… --profile build
bun tools/demo-agent.mjs --list-profiles     # build · db · laptop
```

The screenshot above was taken this way. It is a convenience, not a test double — the two
implementations are held to one contract by `packages/protocol/conformance`.

## Connecting an AI CLI to pdmux

An AI CLI can drive pdmux over MCP — reading host state, running commands, registering machines —
without opening this repository. There are two credentials, and the difference is how far each one
reaches.

**A host key**, issued from a host's detail page, reaches that one machine. No tool in that mode
takes a host id, so there is no way to point it at another.

**An account token**, issued on **Coding CLI access**, reaches every host you can see, at one of
three permission levels: read-only, operate (register a host, update an agent, run commands) or
admin (delete a host, roll an update across several). It expires, it is revocable, and every change
it makes is in the audit log.

```
Codex   codex mcp add pdmux --url <origin>/mcp --bearer-token-env-var PDMUX_MCP_TOKEN
Claude  {"mcpServers":{"pdmux":{"type":"http","url":"<origin>/mcp",
          "headers":{"Authorization":"Bearer ${PDMUX_MCP_TOKEN}"}}}}
```

**Neither can create another credential.** That is the line worth reading twice: a credential that
could mint credentials would turn one leak into a foothold that revoking the original does not close.
The configuration you copy carries an environment variable name rather than the secret, because a
config block is the thing most likely to end up committed.

### pdmux never connects to a host

The agent dials out; nothing dials in. A host's `address` is operator context only — free-form text
pdmux never opens a connection to. So when something has to run **on** a machine, these tools hand
the AI the exact command and the AI runs it over its own ssh, asking you for access if it does not
already have it. pdmux holds no ssh credentials, and adding them would undo the property the whole
architecture is built on.

That makes "add a host and install the agent" three steps rather than one:

```
1. host_create { label: "build-01", address: "build-01.internal" }
      → the host, plus a single-use install command that expires in 15 minutes
2. the AI runs it, from its own shell:
      ssh <destination> 'curl -fsSL <origin>/install.sh | PDMUX_CODE=pdmxe_… sh -s -- --user'
3. host_detail { hostId }  → online: true, a few seconds later
```

Step 3 is not optional: the installer exits before the agent's first handshake, so exit code 0 does
not mean connected. The full tool list, the confirmation protocol for anything destructive, and the
error codes are in [docs/MCP.md](docs/MCP.md).

## Repository layout

| | |
|---|---|
| `apps/api` | Elysia on Bun + TypeORM on PostgreSQL. Host registry, agent gateway, metric retention, git storage, personalisation |
| `apps/web` | SvelteKit + Tailwind v4 + shadcn-svelte. The dashboard and the admin screens |
| `apps/desktop` | Electron shell for the same API and web build, with local providers, backups, tray integration, and packaging |
| `agent` | The Go daemon that runs on each host. PTY, resources, sessions, service probes, read-only git. Not a Bun workspace |
| `packages/protocol` | The agent↔server contract, as zod. The apps import it; the agent embeds a JSON Schema generated from it |
| `packages/core` | Logic with no framework: terminal grid state, gauges, sparklines, commit lane placement |
| `packages/ui` | The Svelte 5 components, publishable on their own |

`@pdmux/ui` and `@pdmux/core` are meant to be usable outside this app: data goes in as props,
behaviour comes out as callbacks, and strings are injected by the consumer.
[docs/COMPONENTS.md](docs/COMPONENTS.md) is the contract.

## Development

Working on pdmux does not use the production images. The two Bun apps run in watch mode with the
dependencies in containers, so an edit is on screen without a production build:

```bash
bun install
cp .env.example .env
docker compose --env-file .env \
  -f infra/docker/docker-compose.yml -f infra/docker/minio.compose.yml -p pdmux \
  up -d postgres redis minio minio-init
bunx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts
bun run --cwd apps/api migration:run
bun run dev
```

Web on `5001`, API on `5002`, Postgres `5440`, Redis `6390`, MinIO `9010` (console `9011`). Change
them in `.env` if they collide. Why this is a development path and not a way to serve the product is
[docs/OPERATIONS.md](docs/OPERATIONS.md) §1-1.

```bash
bun run lint                # type-check both apps and the packages
bun run test                # unit tests for every workspace
cd agent && go test ./...   # the agent is a Go module, not part of the Bun workspaces
bun run test:e2e            # Playwright, against a running stack
bun run build:agent         # linux/darwin × amd64/arm64 — needs a Go toolchain, and is
                            # deliberately not part of `bun run build`
```

UI tests assert **geometry**, not just the DOM: whether a list really is a scroll container, whether a
clicked panel is inside the viewport, whether the page itself stays put. That came out of fixing the
same "clicking does nothing" bug three times while every DOM query insisted the content was there
([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §7).

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why push instead of pull, why the terminal is same-origin, how read-only git is enforced, why the UI is verified by geometry |
| [MCP.md](docs/MCP.md) | The two credentials, why `hostId` became a parameter and what replaced the guarantee it removed, and why a destructive tool describes before it acts |
| [CONTRACTS.md](docs/CONTRACTS.md) | The agent↔server protocol: envelopes, enrollment, remote update, and the additions-only rule |
| [OPERATIONS.md](docs/OPERATIONS.md) | Deployment, agent onboarding, retention, backup and recovery, and a table of symptoms |
| [AGENT_GO.md](docs/AGENT_GO.md) | The agent's layout, what is generated versus hand-written, and the `go generate` procedure |
| [VERSIONING.md](docs/VERSIONING.md) | Two SemVer lines and why they move apart, `PROTOCOL_VERSION`, and the CI checks behind them |
| [COMPONENTS.md](docs/COMPONENTS.md) | `@pdmux/ui` props and events, and where the style boundary sits |
| [USAGE-COLLECTION.md](docs/USAGE-COLLECTION.md) | How token budgets are read without running the CLI, and how to find the format again when it moves |
| [IME_INPUT.md](docs/IME_INPUT.md) | Composed input on mobile (Korean, Japanese, Chinese) and what is not supported |

[AGENTS.md](AGENTS.md) holds the conventions for writing code here, for people and AI CLIs alike.

## License

Apache-2.0. See [LICENSE](LICENSE).
