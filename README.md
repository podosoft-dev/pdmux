# pdmux

Self-hosted dashboard for the machines you develop on. Resource trends, split terminals and a
read-only commit graph for every host, on one page.

[한국어 README](README-ko.md)

![The pdmux dashboard: host cards on the left, two terminals in the middle, a commit graph on the right](docs/media/dashboard.png)

Each host runs a small agent that dials **out** to the server. A laptop, a box under someone's desk
and a cloud VM all show up the same way, with no inbound ports, no VPN and no SSH keys to hand
around.

## What you get

- **Host cards** — CPU, memory and disk with a recent trend, remaining budget for the coding agents
  running there, and one-click links to the services that host exposes.
- **Terminals** — tabs, or 2/4/9 splits, over any host in the fleet. Sessions live in a multiplexer
  on the host, so closing the tab does not kill what is running.
- **Commit graph** — branches, tags, uncommitted changes, and a commit's diff on click. Read-only:
  the collector never fetches, gcs or checks out.
- **Yours** — split layout, which widgets are on, and the default host are stored on the account, so
  the same screen opens on another computer.
- **For a team** — organisations, roles, invitations and an audit log, on top of
  [PodoKit](https://github.com/podosoft-dev/podokit).

## How it works

```
browser ──── HTTPS / WebSocket ────▶ pdmux ◀──── WebSocket (outbound) ──── agent (one per host)
                                      │
                                      ├─ PostgreSQL   hosts, services, layouts, metrics, commit metadata
                                      ├─ Redis        sessions, pub/sub, rate limits, job queues
                                      └─ S3 / MinIO   commit patches
```

The agent is a single static Go binary. It opens one outbound WebSocket and does everything over it:
heartbeats, PTYs, git snapshots, service probes. The server owns the configuration — collection
intervals, git roots, probe targets — and pushes changes down live, so you do not have to get back
onto the host to change them.

Upgrading the agent is done from the dashboard too. Before swapping the binary, the running agent
executes the candidate and makes it complete a real handshake; after swapping it stays on probation
and restores the old binary if it cannot connect. The reasoning is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2-1.

## Running it

Start the dependencies and the two apps:

```bash
npm install
cp .env.example .env
docker compose --env-file .env \
  -f infra/docker/docker-compose.yml -f infra/docker/minio.compose.yml -p pdmux \
  up -d postgres redis minio minio-init
npx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts
npm run migration:run -w pdmux-api
npm run dev
```

Web on `5001`, API on `5002`, Postgres `5440`, Redis `6390`, MinIO `9010` (console `9011`). Change
them in `.env` if they collide.

Add a host in the UI and it hands you the install command, enrollment code included:

```bash
curl -fsSL https://<your-pdmux>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
```

Nothing needs to be installed on the target first — no runtime, no compiler. The code is single-use
and expires in 15 minutes; the long-lived token is exchanged inside the binary and written to a 0600
file, so it never reaches your shell history. `--user` installs it as a per-user service without
root. Air-gapped machines get a token instead: [docs/OPERATIONS.md](docs/OPERATIONS.md) §2-4.

For production — containers, a gateway, retention, backups — see
[docs/OPERATIONS.md](docs/OPERATIONS.md) §1.

### Trying it without any machines

`tools/demo-agent.mjs` speaks the agent side of the protocol, so you can fill a dashboard with no
hosts at all. Add a host in the UI, mint a token on its detail page, then:

```bash
node tools/demo-agent.mjs --server http://localhost:5001 --token pdmux_… --profile build
node tools/demo-agent.mjs --list-profiles     # build · db · laptop
```

The screenshot above was taken this way. It is a convenience, not a test double — the two
implementations are held to one contract by `packages/protocol/conformance`.

## Repository layout

| | |
|---|---|
| `apps/api` | NestJS + TypeORM on PostgreSQL. Host registry, agent gateway, metric retention, git storage, personalisation |
| `apps/web` | SvelteKit + Tailwind v4 + shadcn-svelte. The dashboard and the admin screens |
| `agent` | The Go daemon that runs on each host. PTY, resources, sessions, service probes, read-only git. Not an npm workspace |
| `packages/protocol` | The agent↔server contract, as zod. The apps import it; the agent embeds a JSON Schema generated from it |
| `packages/core` | Logic with no framework: terminal grid state, gauges, sparklines, commit lane placement |
| `packages/ui` | The Svelte 5 components, publishable on their own |

`@pdmux/ui` and `@pdmux/core` are deliberately usable outside this app — data goes in as props,
behaviour comes out as callbacks, and strings are injected by the consumer.
[docs/COMPONENTS.md](docs/COMPONENTS.md) is the contract.

## Development

```bash
npm run lint                # type-check both apps and the packages
npm test                    # unit tests for every workspace
cd agent && go test ./...   # the agent is a Go module, not part of npm test
npm run test:e2e            # Playwright, against a running stack
```

UI tests assert **geometry**, not just the DOM: whether a list really is a scroll container, whether
a clicked panel is inside the viewport, whether the page itself stays put. That came out of fixing
the same "clicking does nothing" bug three times while every DOM query said the content was there
([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §7).

Building the agent binaries needs a Go toolchain and is not part of `npm run build`:

```bash
npm run build:agent         # linux/darwin × amd64/arm64, plus SHA256SUMS and manifest.json
```

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why push instead of pull, why the terminal is same-origin, how read-only git is enforced, why the UI is verified by geometry |
| [CONTRACTS.md](docs/CONTRACTS.md) | The agent↔server protocol: envelopes, enrollment, remote update, and the additions-only rule |
| [OPERATIONS.md](docs/OPERATIONS.md) | Deployment, agent onboarding, retention, backup and recovery, and a table of symptoms |
| [AGENT_GO.md](docs/AGENT_GO.md) | The agent's layout, what is generated versus hand-written, and the `go generate` procedure |
| [VERSIONING.md](docs/VERSIONING.md) | Two SemVer lines and why they move apart, `PROTOCOL_VERSION`, and the CI checks behind them |
| [COMPONENTS.md](docs/COMPONENTS.md) | `@pdmux/ui` props and events, and where the style boundary sits |
| [USAGE-COLLECTION.md](docs/USAGE-COLLECTION.md) | How coding-agent budgets are read without running the CLI, and how to find the format again when it moves |
| [IME_INPUT.md](docs/IME_INPUT.md) | Composed input on mobile (Korean, Japanese, Chinese) and what is not supported |

[AGENTS.md](AGENTS.md) holds the conventions for writing code here, for people and coding agents
alike.

## License

Apache-2.0. See [LICENSE](LICENSE).
