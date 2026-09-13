# Isolated runtime verification

The readiness suite launches production API and web builds through the desktop loopback gateway,
creates temporary accounts and a SQLite database, and installs the real agent in a disposable Docker
container. It covers MCP onboarding and command execution, fleet configuration delivery, audit UI,
organization isolation, folder transfers and ZIP resume, and SSE updates with polling recovery.

Run on Linux with Node, Bun 1.4.0, Docker, and the Playwright Chromium browser installed. Build the
workspace and agent artifacts first as described in [desktop development](DESKTOP.md#desktop-development).
The suite invokes Playwright with Node; the application processes still use Bun.

```bash
bunx playwright install chromium
bun run build:agent
bun run build
bun run test:readiness
READINESS_DATABASE=postgres bun run test:readiness
```

The PostgreSQL variant creates its own loopback-only container and exercises the same application
flow against PostgreSQL. Neither variant reads an existing application's credentials or uses the
shared E2E account seed. Do not run a build while these tests are serving that build output.
The agent fixture uses `--no-service`; systemd/launchd installation and native OS dialogs require
their own verification. Browser captures are written to `tests/test-results/`.

## Optional Cloudflare verification

This test creates real DNS, Access and Tunnel resources. Use a dedicated, unused test hostname and
an existing allow policy. Provide a private JSON file with `hostname`, `apiToken`, `zoneId`,
`baseDomain`, and `accessPolicyId`, and restrict the file to its owner. Never commit this file.

```bash
READINESS_CLOUDFLARE=/path/to/private-config.json bun run test:readiness
```

The test waits for the real agent's connector, verifies an Access redirect, explicitly switches the
test service to public, checks its fixed response, and deletes the exposure, service and integration
in teardown. It resolves the hostname through public DNS over HTTPS, preserving TLS hostname
verification, so a split-DNS development network does not hide newly published records. Without the
configuration file this one test is explicitly skipped. If provider cleanup fails, inspect and remove
only the resources created for that test before repeating it.
