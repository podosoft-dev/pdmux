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
3. Open pdmux normally. macOS may show its standard first-download confirmation.

Official packages starting with **0.17.1** use Developer ID signing and Apple notarization.
Their app and DMG carry stapled tickets. You do not need Open Anyway, quarantine removal,
or a custom trusted certificate. If Gatekeeper rejects a verified new download, retain the
message and report it rather than disabling Gatekeeper.

## Update and preserve data

Use **Create backup** before a manual replacement. Data is stored in
`~/Library/Application Support/pdmux-desktop`, separately from the application bundle.
Replace only `pdmux.app` and keep that data directory.

For unsigned or self-signed **0.17.0 or earlier**, install the new DMG manually once. Later
Developer ID releases retain the signing identity and keep signature verification and the
backup-before-update gate. Do not re-sign the application yourself.

## Build locally

Install Xcode Command Line Tools (`xcode-select --install`), then follow the
[native build instructions](README.md#build-without-publishing).
Intel and Apple Silicon are built independently so the bundled Bun matches the
target. Maintainers use the [Developer ID signing procedure](../DESKTOP.md#developer-id-product-packaging)
for releases; disposable CI signing keys are never published.
