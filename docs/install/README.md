# Install pdmux desktop

Download installers and `DESKTOP-SHA256SUMS` from the same
[official release](https://github.com/podosoft-dev/pdmux/releases/latest).
The application includes Electron, Bun, the API, the web app, and SQLite; Docker,
PostgreSQL, Redis, Node, and a compiler are not installation prerequisites.

| Platform | Installer | Instructions |
|---|---|---|
| macOS Apple Silicon | `pdmux-<version>-mac-arm64.dmg` | [macOS](macos.md) |
| macOS Intel | `pdmux-<version>-mac-x64.dmg` | [macOS](macos.md) |
| Windows x64 | `pdmux-<version>-win-x64.exe` | [Windows](windows.md) |
| Linux x64 | `pdmux-<version>-linux-x86_64.AppImage` or `pdmux-<version>-linux-amd64.deb` | [Linux](linux.md) |

macOS ZIP files and `latest*.yml` files support automatic updates. Install the DMG
when setting up a Mac manually. Linux ARM and Windows ARM desktop installers are
not currently built. The separately downloaded **host agent** supports Linux and
macOS; installing the Windows desktop app does not add a Windows host agent.

Local mode stores data on this computer. Remote mode connects to an existing
HTTPS server. See [desktop configuration and backups](../DESKTOP.md) and
[troubleshooting](troubleshooting.md). Replacing an installer preserves the data
directory; see [uninstalling](uninstall.md) before removing data.

## Build without publishing

Use the operating system and CPU architecture you are building for. Install
Git, Bun **1.4.0**, Node LTS (electron-builder tooling), and the Go version pinned
in `agent/go.mod`. macOS also needs Xcode Command Line Tools. Linux packaging uses
Ubuntu 24.04 in CI. Windows build commands run from PowerShell.

```bash
git clone https://github.com/podosoft-dev/pdmux.git
cd pdmux
bun ci
bun run desktop:package
```

Artifacts appear in `apps/desktop/release/`. This command must not publish to
GitHub. A local macOS build does not have the stable release signing identity;
maintained macOS releases use the [release signing process](../DESKTOP.md#self-signed-product-packaging).
The `desktop` workflow builds all four native targets and retains validation
artifacts. Only the release workflow publishes maintained installers.
