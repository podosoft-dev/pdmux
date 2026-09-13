# Install on Linux

Use an x86_64 desktop with X11 or Wayland. The native package pipeline uses
Ubuntu 24.04. Download an AppImage or Debian package and `DESKTOP-SHA256SUMS`
from the same [official release](https://github.com/podosoft-dev/pdmux/releases/latest).
No Docker or external database is required for local mode.

## AppImage

Replace the filename with the version you downloaded:

```bash
sha256sum "pdmux-<version>-linux-x86_64.AppImage"
chmod +x "pdmux-<version>-linux-x86_64.AppImage"
./pdmux-<version>-linux-x86_64.AppImage
```

Compare the hash with the exact filename in `DESKTOP-SHA256SUMS` before running
it. Keep the AppImage in a directory your user can write to for updates.
If FUSE is unavailable, extract the verified AppImage and run it:

```bash
./pdmux-<version>-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

The extracted copy is manually updated by replacing it with a new verified
extraction. Do not disable Chromium's sandbox to work around a launch failure.

## Debian / Ubuntu package

```bash
sha256sum "pdmux-<version>-linux-amd64.deb"
sudo apt install "./pdmux-<version>-linux-amd64.deb"
```

Verify the hash first. Launch **pdmux** from the application menu. Use the same
`apt install` command with a newer package to update; DEB updates are managed by
the package manager, rather than AppImage's in-app replacement.

## Data and shutdown

Data defaults to `~/.config/pdmux-desktop` (or `$XDG_CONFIG_HOME/pdmux-desktop` when configured).
Use **Create backup** from the tray menu. Quit through the tray menu before
replacing the application. Keep the data directory to preserve the local database,
files, and backups.

## Build locally

Follow the [native build instructions](README.md#build-without-publishing) on
Linux x64. Both AppImage and DEB are produced. The separate ARM64 host-agent
binary is supported, but an ARM64 desktop installer is not currently shipped.
See [troubleshooting](troubleshooting.md) for display and sandbox problems.
