# Desktop installation troubleshooting

| Symptom | Check |
|---|---|
| macOS says the app is damaged or cannot be opened | Verify the official DMG and installed signature, then follow the app-specific [quarantine removal](macos.md#install-and-open). |
| Windows blocks the installer | Check SHA-256 and the official source, then follow the [SmartScreen instructions](windows.md#verify-and-install). Managed policy may need administrator approval. |
| Linux AppImage cannot mount | Use the [verified extraction path](linux.md#appimage), or install the DEB on Debian/Ubuntu. |
| Linux reports a sandbox or user-namespace error | Use the DEB and inspect the distribution's sandbox/AppArmor policy. Keep sandboxing enabled; do not run the app as root. |
| Closing the window does not stop the app | Close-to-tray is enabled by default. Use the tray menu's Quit action. |
| The dashboard contains no hosts | Register a host and install its agent. Installing the desktop alone does not enroll the current computer. |
| The app fails after an update | Preserve the data directory and backups. Record the OS, CPU, version, installer format, and error before reinstalling the verified package. |

The desktop starts local services on dynamically selected loopback ports. A
running server edition does not share its database or login automatically.
Use [remote mode](../DESKTOP.md#remote-mode) to connect to an existing server.

For bug reports, include the installer filename and reproduction steps. Remove
tokens, passwords, enrollment codes, and private host information from logs.
