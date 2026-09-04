# Desktop application

The desktop edition packages the existing pdmux API and web build inside a thin Electron lifecycle
shell. It does not maintain a second frontend or a desktop-only copy of product services.

## Runtime profile

The server and desktop editions share capability boundaries while selecting different providers:

| Capability | Server default | Desktop default |
|---|---|---|
| Database | PostgreSQL | SQLite in the Electron user-data directory |
| Cache and rate-limit counters | Redis | bounded in-process memory |
| Object storage | S3-compatible storage | path-confined local files |
| Events | Redis pub/sub | in-process event transport |
| Jobs | BullMQ and a worker process | in-process job runner |

The desktop process starts a bundled Bun runtime three times in order: database migration, API, and
SvelteKit server. API and web ports are dynamically allocated on `127.0.0.1`; they are never bound to
the LAN. The API receives explicit provider settings, so it does not probe or connect to Redis, S3,
or PostgreSQL. A persistent random authentication secret is stored with user-only file permissions.

SQLite stores PodoKit authentication tables, module settings and audit entries alongside pdmux's
TypeORM entities. PostgreSQL JSON, timestamp, and array entity metadata is translated by one SQLite
driver adapter, keeping repository and service code shared. Desktop startup is idempotent: Better
Auth migrations and application schema synchronization can run again after an interrupted update.

Provider selection changes configuration and future reads/writes only. It never moves or deletes
data from another provider. Export or migration between a server installation and a desktop profile
must therefore be an explicit operation.

## Data and backups

The Electron user-data directory contains:

```text
desktop.json
runtime/
  auth.secret
  pdmux.sqlite
  files/
backups/
  <UTC timestamp>/
    manifest.json
    pdmux.sqlite
    files/
```

Use **Create backup** from the tray menu. The backup helper checkpoints SQLite, creates a consistent
database copy with `VACUUM INTO`, copies the atomically-written object tree, writes a manifest, and
only then publishes the timestamped generation. Incomplete temporary generations are not treated as
backups. Five generations are retained by default; set `backupRetention` in `desktop.json` to a value
from 1 to 100. A downloaded update uses the same backup gate before installation.

## Remote mode

Desktop mode can be used as a secure shell for an existing server instead of starting local
services. Quit pdmux, edit `desktop.json` in the user-data directory, and restart:

```json
{
  "mode": "remote",
  "url": "https://example.com",
  "certificatePins": [
    "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
  ],
  "closeToTray": true
}
```

Only HTTPS URLs are accepted. Each pin is the server certificate's SHA-256 fingerprint, with or
without colons. The configured hostname and one of the pins must both match. Navigation remains on
the application origin; other HTTPS links open in the operating-system browser, while plaintext and
custom-scheme navigation is denied. Changing a certificate requires updating the pin deliberately.

## Building installers

Installers are built on their native GitHub-hosted operating systems by
`.github/workflows/desktop.yml`:

- macOS: Intel and Apple Silicon DMG and ZIP;
- Windows: x64 NSIS installer;
- Linux: x64 AppImage and Debian package.

The workflow builds shared packages, the API, the SvelteKit app and host-agent artifacts, copies the
current platform's pinned Bun executable into the application resources, runs desktop tests, and
uploads installers as architecture-specific workflow artifacts. Intel and Apple Silicon packages
run on separate native macOS runners so their embedded Bun executable always matches the target.
Desktop staging keeps only the API entry points and the current release of each supported host-agent
binary, and installer packaging excludes production source maps and unused Electron locales.
The workflow uses standard GitHub-hosted runners, whose usage is free and unlimited for public
repositories according to the [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Pull requests produce unsigned validation artifacts.
Manual runs can require signing credentials through the `signed` input. Configure the documented
`DESKTOP_CSC_*` and `DESKTOP_APPLE_*` repository secrets before requesting a signed build.

For a local artifact on the current operating system:

```bash
bun install
bun run desktop:package
```

This command does not publish anything. Publishing installers, creating a tag, or attaching files to
a GitHub Release remains a separate release action.

## Desktop development

Build the API and web app first, then compile the shell:

```bash
bun run --filter @pdmux/protocol build
bun run --filter @pdmux/core build
bun run --filter @pdmux/ui build
bun run --filter @pdmux/mcp build
bun run --filter pdmux-api build
bun run --filter pdmux-web build
bun run --filter pdmux-desktop build
```

Set `PDMUX_BUN_EXECUTABLE` only when `bun` is not on the desktop development process's `PATH`.
Desktop unit tests do not start application services:

```bash
bun run --filter pdmux-desktop lint
bun run --filter pdmux-desktop test
```
