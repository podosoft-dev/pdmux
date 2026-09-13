# Install on Windows

Use a Windows x64 desktop. Download `pdmux-<version>-win-x64.exe` and
`DESKTOP-SHA256SUMS` from the same
[official release](https://github.com/podosoft-dev/pdmux/releases/latest).
This is an NSIS installer; there is no separate MSI or WebView2 setup.

## Verify and install

In PowerShell, check the file you downloaded (replace the filename):

```powershell
Get-FileHash -Algorithm SHA256 ".\pdmux-<version>-win-x64.exe"
```

Compare the result with that exact filename in `DESKTOP-SHA256SUMS`.
Quit an existing pdmux from its tray menu, run the installer, and choose the
installation directory in the wizard. The embedded local stack starts on first
launch; there is no database service to install.

Windows releases are unsigned. If SmartScreen displays **Windows protected your
PC**, use **More info → Run anyway** only for the verified official installer.
Do not disable SmartScreen or antivirus globally. Organization policy can require
an administrator to approve an unsigned application.

## Data and updates

Data and backups are stored in `%APPDATA%\pdmux-desktop`. Use **Create backup** from the
tray menu before a manual upgrade. Re-run the new installer to replace the app;
keep the data directory. Closing the window normally leaves pdmux in the tray;
use **Quit** to stop the embedded services.

The desktop can manage Linux and macOS hosts. A native Windows host agent is not
included, so installing this desktop does not automatically register the Windows
machine as a terminal host.

## Build locally

Install Git for Windows, Bun 1.4.0, Node LTS, and the Go version in `agent/go.mod`.
Run the [native build commands](README.md#build-without-publishing) in PowerShell.
The native Windows CI job produces the x64 EXE. Installer downloads and native
runtime verification are separate checks; see [troubleshooting](troubleshooting.md).
