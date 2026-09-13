# Install on macOS

## Choose and verify the download

Check **Apple menu → About This Mac**. Apple Silicon uses the `mac-arm64.dmg`;
Intel uses `mac-x64.dmg`. Both run the complete local pdmux application.
Download the DMG and `DESKTOP-SHA256SUMS` from the same
[official release](https://github.com/podosoft-dev/pdmux/releases/latest).
In Terminal, run `shasum -a 256` followed by the downloaded DMG path and compare
the result with its exact filename in `DESKTOP-SHA256SUMS`.

## Install and open

1. Quit any running pdmux using **pdmux tray menu → Quit**.
2. Open the DMG and drag **pdmux.app** into **Applications**.
3. Open pdmux. If macOS blocks it, use **System Settings → Privacy & Security →
   Open Anyway** after attempting to open it once.

Official packages starting with 0.12.3 use a stable, free, app-specific
self-signed certificate. They are not Apple Developer ID signed or notarized,
so a first-launch exception can be necessary.

If the verified app is reported as damaged or macOS offers no Open Anyway action,
verify the installed signature, then remove quarantine for this app only:

```bash
codesign --verify --deep --strict "/Applications/pdmux.app"
xattr -dr com.apple.quarantine "/Applications/pdmux.app"
```

Run `xattr` after checksum and signature verification succeed and you trust the
official download. Adjust the quoted path if you installed elsewhere. Open the
app again. This does not require disabling Gatekeeper or installing a certificate.
If signature verification fails, download a fresh official copy instead.
See [Apple's first-launch exception instructions](https://support.apple.com/en-us/102445).

## Update and preserve data

Use **Create backup** before a manual replacement. Data is stored in
`~/Library/Application Support/pdmux-desktop`, separately from the application bundle.
Replace only `pdmux.app` and keep that data directory.

For unsigned **0.12.1 or earlier**, install the new DMG manually once. Later
releases retain the signing identity and keep signature verification and the
backup-before-update gate. Do not re-sign the application yourself.

## Build locally

Install Xcode Command Line Tools (`xcode-select --install`), then follow the
[native build instructions](README.md#build-without-publishing).
Intel and Apple Silicon are built independently so the bundled Bun matches the
target. Maintainers use the [stable signing procedure](../DESKTOP.md#self-signed-product-packaging)
for releases; disposable CI signing keys are never published.
