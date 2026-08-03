# pdmux

*[한국어 README](README-ko.md)*

**A self-hosted dashboard for operating several development machines from one screen.**
Host cards (resource trends, agent token budgets, service shortcuts), a split view of several
terminals, and a read-only commit graph, gathered onto one page. Every signed-in user gets their own
screen, and a machine in any environment can take part **with nothing but an outbound connection**.

```
┌── hosts ────────────┬──────────── terminals ────────────┬── git ──┐
│ ● build-01     ⚙   │  #1 build-01 · main   #2 db-02 …  │ ● main  │
│   claude 3 ███░ 82% │  ┌──────────────┬──────────────┐  │ │ feat… │
│   cpu 13% ╱╲__      │  │              │              │  │ ├─╯     │
│   [● api      ▾][open]│ └──────────────┴──────────────┘  │ …      │
└─────────────────────┴───────────────────────────────────┴─────────┘
```

- **From anywhere** — the agent dials out to the server, so there are no inbound ports, no VPN and no
  SSH key distribution.
- **Per user** — split arrangements, visible widgets and the default host are stored on the account
  and open the same way on another device.
- **As a team** — organisations, roles, invitations, an audit log and admin settings (the
  authentication foundation is [PodoKit](https://github.com/podosoft-dev/podokit)).
- **Reusable** — the dashboard UI is `@pdmux/ui` and the logic is `@pdmux/core`, split out so another
  project can use them.

## Layout

| Workspace | Contents |
|---|---|
| `apps/api` | NestJS + TypeORM (PostgreSQL) — host registry, agent gateway, metric retention, git storage, personalisation |
| `apps/web` | SvelteKit + Tailwind v4 + shadcn-svelte — the dashboard and admin screens |
| `agent` | the Go daemon installed on hosts (not an npm workspace) — PTY, resources, sessions, service probes, read-only git snapshots. Shipped as a static binary |
| `packages/protocol` | the agent↔server contract (zod). The API and web use it directly; the Go agent reads a JSON Schema derived from it |
| `packages/core` | framework-free logic — terminal grid state, gauges, sparklines, commit lane placement |
| `packages/ui` | the Svelte 5 component library |

## Development environment

```bash
npm install
cp .env.example .env                     # change ports here if they collide
docker compose --env-file .env \
  -f infra/docker/docker-compose.yml -f infra/docker/minio.compose.yml -p pdmux \
  up -d postgres redis minio minio-init
npx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts
npm run migration:run -w pdmux-api
npm run dev                              # api :5002 · web :5001
```

Default ports: web `5001` · api `5002` · postgres `5440` · redis `6390` · minio `9010`
(console `9011`). The container gateway (`podo dev`) takes `127.0.0.1:80`, so on a workstation
already using port 80, start it in **host-process mode** as above.

Installing the agent is **one line** on each machine. Creating a host in the dashboard produces this
command with an enrollment code already in it:

```bash
curl -fsSL https://<pdmux>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
```

The target machine needs no language runtime and no compiler (one static Go binary). The code is
**single-use and expires in 15 minutes**, and the long-lived token is exchanged **inside the binary**
rather than in the script, reaching nothing but a 0600 configuration file. With `--user` it installs
as a per-user service without root. For an air-gapped machine, move the binary across and install it
with `pdmux-agent install --server … --token …` — see
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) §2-4.

Replacing an agent with a new build is also done **from the dashboard**. Each agent checks that the
candidate can reach the server before swapping, and rolls itself back if it cannot connect within the
grace period afterwards ([`docs/OPERATIONS.md`](docs/OPERATIONS.md) §2-3).

Building the agent release binaries yourself needs a Go toolchain (it is **not part of** the root
`npm run build`):

```bash
npm run build:agent          # linux·darwin × amd64·arm64 + SHA256SUMS + manifest.json
cd agent && go test ./...
```

## Tests

```bash
npm test                    # workspace unit tests
cd agent && go test ./...   # the agent — not an npm workspace, so not part of npm test
npm run test:e2e            # Playwright (the stack must be up)
```

The UI tests check whether things are **visible** (scroll container, inside the viewport, hit-test) —
we learned expensively that being in the DOM and being on screen are different things. The background
is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7.

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | why push rather than pull, why the terminal is same-origin, read-only git, the component split, verifying by geometry |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | the agent↔server protocol (additions only), enrollment and remote-update frames |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | deployment shape, **agent onboarding**, retention, backups, states you see often |
| [`docs/AGENT_GO.md`](docs/AGENT_GO.md) | the Go agent's layout, generated versus hand-written, the `go generate` procedure |
| [`docs/VERSIONING.md`](docs/VERSIONING.md) | the two SemVer lines, `PROTOCOL_VERSION`, the CI checks that keep the manifest honest |
| [`docs/COMPONENTS.md`](docs/COMPONENTS.md) | the `@pdmux/ui` props/events contract |
| [`docs/USAGE-COLLECTION.md`](docs/USAGE-COLLECTION.md) | coding-CLI usage — the one collector that leans on somebody else's format |
| [`docs/IME_INPUT.md`](docs/IME_INPUT.md) | the input path for composed characters (Korean, Japanese, Chinese) and **its limits** |
| [`AGENTS.md`](AGENTS.md) | the rules for writing code here (for people and AI alike) |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
