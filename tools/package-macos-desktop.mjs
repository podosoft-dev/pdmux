#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { disposableSigning, probeEnvironment } from "./probe-macos-adhoc-update.mjs";

const repository = resolve(import.meta.dirname, "..");

export function macSigningConfiguration(base, identity) {
  assert.ok(typeof identity === "string" && identity.trim() && identity !== "-", "A stable certificate identity is required; ad-hoc signing cannot update safely");
  return {
    ...base,
    forceCodeSigning: true,
    mac: {
      ...base.mac, identity, notarize: false, hardenedRuntime: true, strictVerify: true,
      binaries: ["Contents/Resources/bin/bun"],
      // Downloadable agents have immutable checksums and are resources, not app helpers.
      signIgnore: ["/Contents/Resources/web/client/agent/[^/]+/pdmux-agent-(linux|darwin)-(amd64|arm64)$"],
    },
  };
}

export function macPackagingArguments(desktop, configurationPath, arch) {
  assert.ok(arch === "arm64" || arch === "x64", "Unsupported macOS architecture");
  // Let the existing package script honor electron-builder's Node shebang.
  // Direct Bun execution hangs in its portable WASM icon converter.
  return ["run", "--cwd", desktop, "package", "--", "--config", configurationPath,
    "--mac", `--${arch}`, "--publish", "never"];
}

export async function packageMac(ciProbe = false) {
  assert.equal(process.platform, "darwin", "Native macOS packaging is required");
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-mac-package-"));
  let signing;
  try {
    if (ciProbe) signing = await disposableSigning(temporary);
    const identity = signing?.identities[0] ?? process.env.PDMUX_MAC_SIGNING_IDENTITY;
    const keychain = signing?.keychain ?? process.env.CSC_KEYCHAIN;
    assert.ok(keychain, "An explicitly provisioned signing keychain is required");
    const desktop = join(repository, "apps/desktop");
    const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
    const configuration = macSigningConfiguration(manifest.build, identity);
    const configurationPath = join(temporary, "builder.json");
    await writeFile(configurationPath, JSON.stringify(configuration));
    const env = {
      ...probeEnvironment(process.env), CSC_KEYCHAIN: keychain,
      CSC_FOR_PULL_REQUEST: ciProbe ? "true" : "false",
    };
    execFileSync(process.execPath, macPackagingArguments(desktop, configurationPath, process.arch),
    { env, stdio: "inherit", timeout: 600_000 });
  } finally {
    if (signing) await signing.cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageMac(process.argv.includes("--ci-probe"));
