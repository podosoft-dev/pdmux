# Desktop application

The desktop edition packages the existing PDMux API and web build inside a thin Electron lifecycle
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
the LAN. A third loopback port is the window's single origin: the shell forwards HTTP to SvelteKit
and only `/agent/ws` and `/terminal/ws` upgrades to the API. It validates the incoming Host and
replaces forwarded authority headers. This keeps installer URLs, MCP, cookies and terminal
connections on the same HTTP origin even with SvelteKit adapters that no longer accept `ORIGIN`.
The API receives explicit provider settings, so it does not probe or connect to Redis, S3,
or PostgreSQL. A persistent random authentication secret is stored with user-only file permissions.
On Windows, runtime processes and backup helpers run with hidden consoles, including automatic
recovery after a child exits. The app's terminal sessions remain inside the dashboard.

SQLite stores PodoKit authentication tables, module settings and audit entries alongside pdmux's
TypeORM entities. PostgreSQL JSON, timestamp, and array entity metadata is translated by one SQLite
driver adapter, keeping repository and service code shared. Raw SQL writes bind JSON strings and
ISO timestamps explicitly, including audit metadata and runtime authentication settings.
Desktop startup is idempotent: Better
Auth migrations and application schema synchronization can run again after an interrupted update.

Provider selection changes configuration and future reads/writes only. It never moves or deletes
data from another provider. Export or migration between a server installation and a desktop profile
must therefore be an explicit operation.

## Local workspace and optional server connection

A normal first launch opens the dashboard without sign-up or a password. The native shell
passes a one-launch capability to the local API over a private pipe and installs an HttpOnly
session in its own browser session. The capability is never exposed to web content, URLs or
command-line arguments. An existing local profile is reused; multiple profiles require a one-time
native profile selection. Ordinary web servers do not accept this bootstrap path.

Open **Server connection** from the user menu to connect one HTTPS server/account/workspace at a
time. Authentication uses the system browser and PKCE; a manual authorization code supports
platforms where a deep link cannot reopen the app. Cloud credentials are kept out of the renderer
and protected with the OS credential store. Without a secure store, the session is memory-only.

The sidebar's **Dashboard** button returns to the terminal screen from every product page,
including Server connection. Host management, settings, CLI access and account pages share this
navigation instead of repeating a dashboard breadcrumb above their headings.

**Host common settings** separates **Local settings** from **Server settings**. Local settings
configure hosts owned by the desktop and exclude server integrations. The server tab becomes
available after login and reads and writes the selected server workspace directly, with the
server's existing permissions. Changing one target does not overwrite the other's configuration.
Disconnecting disables server settings while local settings remain available. The browser edition
continues to configure its own server fleet.

Connecting shares all current and future local hosts with that server. The desktop must remain
running and signed in for the web to operate these hosts; closing to the tray keeps it running.
A single outbound WSS connection carries bounded, cancellable host operations. No LAN listener
or inbound desktop port is opened. Hosts keep their original agent connection and credentials.
The original backend remains responsible for agent configuration and update verification.

Host settings, service definitions, Git scan roots, dashboard layouts, widget preferences,
language and theme synchronize. Unrelated changes merge automatically. Concurrent changes appear
in **Synchronization conflicts** for a local/server choice; first-connection backups preserve the
original workspace. Agent credentials, global server authentication/provider secrets, files,
terminal output and running sessions are not automatically replicated. Explicit file transfers
stream on demand. Cloud session and workspace access are checked again while relaying.

A sync waits for host writes in its workspace and for the same user's preference writes, and those
writes wait for it, so none lands between its comparison and its update unseen. Other users and
workspaces never wait for it. This lock lives in the API process, so a server must run one API
process per database, which the agent registry already requires.

Disconnecting stops synchronization and the relay, while local hosts remain usable. Server hosts
stay visible as an offline read-only cache. Connection state and cached data are separated by server,
account and workspace. This is metadata synchronization, not a PostgreSQL-to-SQLite database copy.
The legacy pinned `remote` mode below remains supported for existing configurations.

Temporary server failures, including gateway 502/503 and rate limits, keep the cloud session and
the synchronization retry loop. The desktop reconnects the bridge and reopens terminal targets
after the server and its agents return, without reloading the window. A bridge or terminal
handshake that stalls is bounded to 15 seconds. Session rejection (401/403), workspace changes,
and an explicit disconnect still stop access. Persistent multiplexer sessions can reattach;
an ephemeral plain shell cannot preserve its process across a disconnect.

## Data and backups

The visible application name is **PDMux**. The legacy bundle/executable and user-data directory
retain their stable identifiers; the user-data directory is `pdmux-desktop`: by default,
`~/Library/Application Support/pdmux-desktop` on macOS, `%APPDATA%\pdmux-desktop` on Windows,
and `~/.config/pdmux-desktop` on Linux (or `$XDG_CONFIG_HOME/pdmux-desktop`). The tray's
**Open data folder** action opens the actual directory. It contains:

```text
desktop.json
runtime/
  auth.secret
  pdmux.sqlite
  files/
  file-transfers/
  agent-cache/
local-profile.json
cloud-session-<profile hash>.encrypted
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
from 1 to 100. A downloaded update uses the same backup gate before installation. Existing databases are also
backed up before startup migrations; starting a new server connection creates a workspace backup.

## Folder transfers

The file explorer shares its transfer controller with the web app. Electron only grants bounded
reads inside a natively selected folder and manages resumable downloads. IPC checks the main-frame
origin; selection tokens do not grant arbitrary path access. Download records live in
`file-transfers/downloads.json` under application data; the embedded API spool is
`runtime/file-transfers`. Temporary transfers are not included in object-storage backups.
The download manager rechecks the authenticated job and immutable ETag before resuming, including
when an embedded loopback port changes, and verifies the archive before publishing the selected
output. See [`FILE-TRANSFERS.md`](FILE-TRANSFERS.md) for limits and expiry.

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
without colons. Electron's `sha256/base64` runtime representation is converted to the same SHA-256
bytes before comparison. The configured hostname and one of the pins must both match. Navigation remains on
the application origin; other HTTPS links open in the operating-system browser, while plaintext and
custom-scheme navigation is denied. Changing a certificate requires updating the pin deliberately.

## Building installers

Installers are built on their native GitHub-hosted operating systems by
`.github/workflows/desktop.yml`:

- macOS: Intel and Apple Silicon DMG and ZIP;
- Windows: x64 NSIS installer;
- Linux: x64 AppImage and Debian package.

One shared job cross-compiles the four host-agent binaries (native macOS for signed releases, Linux
for PR validation) and hands them to every installer runner as
an `agent-binaries` archive, so every installer uses the same canonical catalog and no installer runner needs Go.
Each installer runner then builds shared packages, the API and the SvelteKit app, copies the current
platform's pinned Bun executable into the application resources, runs desktop tests, and uploads
installers as architecture-specific workflow artifacts. Intel and Apple Silicon packages
run on separate native macOS runners so their embedded Bun executable always matches the target.
Desktop staging builds API/migration entry points together with shared chunks. Only the native
supported host-agent binary is bundled; Windows has no native host-agent target. The full canonical
manifest and checksums remain unchanged. Other targets download from an exact official release tag
on first use, with size/SHA-256 verification and an atomic cache outside the signed app. Use the
connection page to pre-download targets before going offline. Missing downloads never prevent local
startup. Installer packaging excludes production source maps and unused Electron locales. The native
auth client is bundled without shipping the server SDK and unused database adapters.

Electron and the pinned Bun runtime account for most installed bytes. Measure installed bundle size
separately from compressed installer size and optional downloaded agent caches. Keeping Electron
provides a substantial runtime floor even after duplicate code and unused agent targets are removed.
The workflow uses standard GitHub-hosted runners, whose usage is free and unlimited for public
repositories according to the [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Pull requests produce disposable self-signed macOS validation artifacts and unsigned Windows/Linux
artifacts. Never distribute the disposable macOS builds as maintained releases.
Release tags require Developer ID signing and Apple notarization. The `desktop-signing` GitHub
environment permits only `v*` tags. It contains the certificate archive/password, certificate SHA-1,
Developer ID G2 intermediate certificate, team ID, and App Store Connect API key/issuer/key ID.
PR builds use disposable identities without production credentials. Signed manual runs must run on
the release tag and package that exact source. A missing key, unexpected certificate or failed
notarization stops the build.

## Installing on macOS

Step-by-step guides: [macOS](install/macos.md), [Windows](install/windows.md),
[Linux](install/linux.md), and [native builds](install/README.md#build-without-publishing).

Starting with **0.17.1**, official macOS apps and Darwin host agents use Developer ID signatures
and Apple notarization. The app and DMG carry stapled tickets; ZIP updates contain the stapled app.
Gatekeeper can show its normal first-download confirmation, but installation does not require an
unidentified-developer exception, quarantine removal, or a custom trusted certificate.

1. Download the native DMG and `DESKTOP-SHA256SUMS` from the same official GitHub release.
   Compare `shasum -a 256 <downloaded-dmg>` with that file.
2. Create a backup, quit pdmux from its tray menu, and copy `pdmux.app` into Applications.
3. Open pdmux normally. Keep `~/Library/Application Support/pdmux-desktop`: it contains your data.

**Unsigned and self-signed versions through 0.17.0 require this manual replacement once.** Their
signing identity cannot authenticate the new Developer ID identity. Later automatic updates retain
signature verification and backup-before-install. Do not re-sign the app or disable Gatekeeper.
Previously published downloads retain their original signatures and checksums.

**Check for updates** opens a checking window, followed by either an up-to-date notice or a
confirmation showing the available version. Downloads start only after confirmation. A separate
progress window displays the percentage and transferred/total bytes, and the Dock or taskbar
also shows progress. Until the total size is known, the indicator is indeterminate. A completed
download offers **Install and restart** or **Later**. Choosing Later keeps the workspace running;
the next manual check reopens the restart confirmation using the staged download. Merely quitting
the app does not install an update. Startup checks remain silent when no update is available.
Concurrent checks share one operation, and failures close the progress window and show a notice.

The updater must finish its backup, allow windows to close and stop file transfers, the embedded
agent and local services before calling `quitAndInstall()`. Squirrel.Mac closes windows before
Electron emits `before-quit`; a close-to-tray handler must not cancel those closes. A failed
backup leaves the running workspace intact and prevents installation. Preparation failures are
shown in a dialog. If an older app hides when installing an update, quit from its tray menu and
reopen it after the staged update is applied, or replace it with the official DMG.

With the desktop shell, API and web builds available, `bun tools/smoke-macos-update-lifecycle.mjs`
checks the real macOS progress windows and runtime against a disposable profile. It verifies
checking, no-update feedback, download consent, percentage changes, postponement and restart.
It requires a completed backup, stopped API/web/agent processes and a closed window before
installer handoff. Network transfers, native dialog choices and the installer are stubbed in
this probe; signed replacement and relaunch remain the separate native update probe.

For a local artifact on the current operating system:

```bash
bun install
bun run desktop:package
```

This command does not publish anything. Publishing installers, creating a tag, or attaching files to
a GitHub Release remains a separate release action.

## Desktop development

### macOS signing and update feasibility gate

`bun tools/probe-macos-adhoc-update.mjs` requires native macOS and runs only against disposable
Electron fixtures. The dedicated `macos-update-probe.yml` workflow uses a Tahoe ARM runner with
read-only repository permissions; it does not publish releases or alter existing releases.
The workflow uses separate `--prepare-self-signed` and `--verify-self-signed` jobs to test temporary
non-Apple signing identities. Preparation is restricted to disposable GitHub CI: it creates two
short-lived certificates in a temporary keychain and trusts them for signing. Private files and the
keychain are removed; the build VM and its temporary trust settings are discarded by GitHub.
Only signed ZIPs and update metadata are handed to a fresh verification VM through a one-day CI
artifact. The verification VM never imports certificates or receives private keys. This avoids
interactive trust-removal commands and prevents build-machine trust from influencing the result.
No production signing credentials are used.

The probe packages two different versions with ad-hoc signatures, extracts and strictly verifies
their ZIP archives, and checks the new app against the old app's exact designated requirement
before exercising `electron-updater` and Squirrel.Mac over a loopback feed. A successful update
must relaunch the new version and preserve a sentinel in an isolated user-data directory.
Signature incompatibility is a hard failure, not a reason to weaken requirements or disable
verification. Fixture success alone does not validate the full embedded stack, backups, or a
browser-downloaded app's Gatekeeper behavior. Those remain separate release acceptance checks.
The self-signed variant builds two versions with one identity and a third with a different identity.
The same-key update must satisfy the unchanged old-app requirement; the different-key app and a
modified copy must be rejected. Only then may the real update and relaunch run. Without mode flags,
the original ad-hoc experiment remains available and fails on cross-version code-hash identity.

The published `0.12.1` macOS packages skipped signing. This probe is preparation for a corrected
distribution, not evidence that those existing packages have been repaired. Free ad-hoc signing
does not provide Developer ID authentication or Apple notarization.

### Developer ID product packaging

Maintainers can run `bun run desktop:package:mac:signed` on a native Mac with the eight `APPLE_*`
credentials described below supplied by their secret-store adapter. It builds the embedded stack,
prepares canonical signed agents, signs/notarizes the app and DMG, staples their tickets, and then
refreshes the final DMG blockmap and update hashes. It never publishes. CI uses the separate
`release-macos-signing.mjs` entrypoint, which retains the exact release-tag/repository checks;
local execution cannot opt a CI job out of those checks.

The credential interface is `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_CODESIGN_IDENTITY` (SHA-1), `APPLE_DEVELOPER_ID_G2_CERT_BASE64`, `APPLE_DEVELOPER_TEAM_ID`,
`APPLE_NOTARY_ISSUER_ID`, `APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_KEY_P8_BASE64`. Secret values
remain in process memory or private temporary files. The importer handles legacy PKCS#12 encryption,
rewraps with a one-use password, imports into a temporary keychain without installing a trusted root,
and removes the keychain and files on success or failure. Node runs electron-builder; the embedded
API and web still run on Bun.

`agent-binaries.yml` builds all four agents once. It verifies the unsigned source build against the
committed checksums, signs and notarizes the two Darwin agents, and updates their distribution
checksums and sizes. The artifact is shared by both image architectures, every desktop installer,
and GitHub downloads. Packaging excludes these already signed agents from re-signing so their bytes
stay identical. The signature seals them as app resources too.

Release verification sets `PDMUX_VERIFY_RELEASE_IDENTITY=1` and runs
`bun tools/verify-macos-desktop.mjs <artifact-directory>`. It independently extracts the ZIP and DMG,
verifies signatures, certificate pins, stapled tickets and Gatekeeper acceptance, runs the embedded
Bun/SQLite, and compares the agents against the canonical artifact supplied in
`PDMUX_AGENT_ARTIFACT_ROOT`. `--runtime` checks the real login page, transfers, backups and preservation
across ZIP-to-DMG replacement. Every smoke launch uses an explicit temporary `--user-data-dir` before
acquiring the app's instance lock. Local verification additionally requires
`PDMUX_LOCAL_DESKTOP_SMOKE=1`; it does not spoof GitHub runner variables or access a real profile.
No production private key or custom certificate trust is installed on clean verification runners.
A real browser-download first launch remains a separate acceptance check.

Pull-request runs of `desktop.yml` build the real product with disposable certificates
(`--ci-probe`) on Intel and Tahoe ARM64, and separate fresh runners verify the artifacts without
importing the signing identity. A separate `macos-package-probe.yml` used to repeat exactly these
steps on the same commits; it was removed because it only doubled macOS runner time
(see [`CI.md`](CI.md)). Run `desktop.yml` by hand with `signed` off for the same check on a branch.
These artifacts must not be published as product releases: their signing keys are deliberately
destroyed and cannot sign future updates.

### Production signing-key lifecycle

The checked-in `apps/desktop/signing-certificate.pem` pins the public Developer ID Application
certificate. Signing also checks its team, private-key match, validity and Developer ID G2 chain.
Keep the certificate/private key and notarization API key in the approved secret store with recovery
procedures. PRs never receive them. Certificate renewal or key rotation is an explicit transition;
never weaken update verification or silently fall back to unsigned output.

Timestamped signatures are not reproducible byte for byte. The canonical agent cache is keyed by
agent version, and released bytes take precedence over local cache entries. Later product releases
reuse the published signed agents after checking source hashes, signatures and certificate pins.
An existing unsigned version or changed source under the same version is rejected. Failed signing
or notarization does not create a reusable cache entry. Only public release files enter the cache.

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

Native installer validation runs on fresh GitHub-hosted machines. Windows installs the actual NSIS
package. Linux checks the DEB installation and extracted AppImage with one data directory. Both
launch the packaged login screen, exercise real folder-selection IPC with the OS chooser automated,
verify SQLite backup integrity, and preserve the authentication key and uploaded files across restart.
macOS runs the same runtime checks after its separate signing and package checks.

Linux also runs `tools/smoke-desktop-downloads.mjs` against the packaged AppImage. A temporary,
certificate-pinned HTTPS fixture serves an authenticated, throttled 8 MiB body. The real Electron
downloader pauses, the application quits, and a new process resumes only the remaining range with
the same ETag. The check verifies authorization denial before resumption, SHA-256 integrity,
destination preservation, and partial-file cleanup. Only the save dialog's selected path is automated.
Chromium sandboxing stays enabled in these native smoke tests. The fixture isolates native download
semantics from the separate real API/agent suite; it does not prove the full product updater cycle.

For isolated end-to-end validation on Linux with Docker, see
[`READINESS.md`](READINESS.md). It uses disposable accounts, real agent installation, and production
API/web builds; it does not connect to an existing user's dashboard.


## Desktop feature profile and the first local terminal

The desktop API and web UI have their own build profiles. The standard web build
continues to include administration, account security, registration, organizations,
and browser sign-in. The desktop build excludes these routes and authentication
plugins, including the shared client's admin, organization, passkey and two-factor
plugins. It also omits PostgreSQL and Redis drivers, S3, BullMQ, server log browsing,
and machine API-key endpoints. SQLite, memory providers, local files, product settings,
MCP, Git, transfers, and optional server synchronization remain available.

`desktop:prepare` builds `apps/api/dist-desktop` and `apps/web/build-desktop` without
changing the ordinary API/web output. Build substitutions are application owned;
generated toolkit modules and the source web routes retain their server behavior.
The desktop menu provides settings, server connection, backup, data folder, and
application update actions. Its native actions accept requests only from the main
application frame and origin.

On first launch, Electron verifies and copies the bundled native agent, creates a
host in the selected local profile, and runs the agent as a supervised child. It
waits for a real agent connection before assigning a plain shell terminal to cell
#1. A populated layout is preserved; a layout deliberately cleared after setup stays
empty on subsequent launches. The server connection page shows agent readiness and
provides a retry action, including replacement credentials when needed.

The default host label uses the system computer name: the friendly Computer Name on macOS,
or the hostname on Windows and Linux. If macOS cannot read its friendly name, it falls back to
the hostname. Labels are limited to 64 characters and receive a numeric suffix when another
host already uses that name. Existing localized default labels are migrated once on startup;
custom labels, host identity, credentials and layouts are preserved. Server synchronization
shares the resulting host label with the web workspace.

The embedded agent is separate from the standalone host installer. Electron owns
its startup, bounded restart attempts, and shutdown. A stdin lifetime pipe cancels
the agent if Electron disappears. Existing launchd/systemd agents are untouched.
Credentials live only in the profile's private `runtime/local-agent/<profile>/agent.json`;
they are never command arguments or environment variables. Each profile has its own
host and process state. The native binary is checked against the canonical manifest
before every start.

The native target set adds Windows x64 in agent **0.1.28**. Windows uses PowerShell
through [ConPTY](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session),
with real terminal input, UTF-8 output and resize. This needs Windows 10 1809 or newer
(or Windows Server 2019 or newer). The default terminal does not require tmux or WSL.
Unix terminals keep their existing PTY implementation and login shell. Windows support
here covers the embedded desktop agent; the standalone shell installer and service
manager updater remain Unix workflows. Collection features that require Unix tools
are unavailable on Windows. Native Windows terminal tests run in the desktop workflow,
and each platform's packaged smoke test checks the first local terminal and menu.

Agent catalogs retain every platform's checksums but installers bundle only their
native agent. Additional remote-host binaries can be downloaded and verified later.
Plain shells end when the desktop app or their connection closes; use tmux sessions
on supported Unix hosts when work must survive a disconnect.
