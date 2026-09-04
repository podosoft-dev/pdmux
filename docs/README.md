# Documentation

These documents record **why pdmux is built the way it is** rather than what was built. Most of the
reasoning came out of failures while actually operating the thing, and those incidents are kept next
to the rules they produced — so a future reader can weigh a rule instead of guessing at its intent.

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | why push rather than pull, why the terminal is same-origin, read-only git, the component split, verifying by geometry |
| [`CONTRACTS.md`](CONTRACTS.md) | the agent↔server protocol (additions only), enrollment and remote-update frames |
| [`MCP.md`](MCP.md) | the two credentials an AI CLI can hold, what each reaches, and which guarantees changed shape when fleet-wide access arrived |
| [`OPERATIONS.md`](OPERATIONS.md) | deployment shape, agent onboarding, retention, backups, states you see often |
| [`AGENT_GO.md`](AGENT_GO.md) | the Go agent's layout, generated versus hand-written, the `go generate` procedure |
| [`USAGE-COLLECTION.md`](USAGE-COLLECTION.md) | ⚠ coding-CLI usage — **the one collector that leans on somebody else's format**. Why the CLI is not executed, and how to find the format again when it moves |
| [`VERSIONING.md`](VERSIONING.md) | the two SemVer lines, `PROTOCOL_VERSION`, the CI checks that keep the manifest honest |
| [`COMPONENTS.md`](COMPONENTS.md) | the `@pdmux/ui` props/events contract and the style boundary (shadcn ↔ the package stylesheet) |
| [`IME_INPUT.md`](IME_INPUT.md) | the input path for composed characters (Korean, Japanese, Chinese) and **its limits** |
| [`DESKTOP.md`](DESKTOP.md) | the embedded SQLite/local-provider profile, desktop lifecycle, backups, remote mode, and platform packaging |

Every test title carries a `[TC-AREA-NNN]` tag, and those identifiers appear throughout these
documents. They point into a requirements matrix that is maintained alongside this repository rather
than inside it; the tag in the test is what makes a claim here checkable against code.
