package cli

// AgentVersion is reported in `hello`, so a server can tell which agents need an
// upgrade, and is what `--version` prints.
//
// Ported from apps/agent/src/version.ts. It lives here rather than in a package
// of its own because the CLI is what prints it and what hands it to the daemon;
// it is the one symbol the release pipeline stamps (`tools/build-agent-binaries.mjs`
// passes `-ldflags -X …/internal/cli.AgentVersion=<version>`).
//
// ⚠ `var`, NOT `const`, AND THAT IS THE WHOLE POINT. The linker's `-X` can only
// write a string *variable* — against a constant it does nothing at all, and says
// nothing while doing it. As a const this built happily with
// `-X …AgentVersion=9.9.9` and still printed 0.1.0, which is the exact failure the
// CI check in Deliverable 4 exists to catch: a manifest promising one version while
// the binary inside reports another leaves every host permanently "outdated".
//
// The literal here is still the single source of truth for the version — the build
// script reads THIS line and stamps the same value back, so an unstamped build (a
// developer's `go build`) and a released one agree.
var AgentVersion = "0.1.16"
