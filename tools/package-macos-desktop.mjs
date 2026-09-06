#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { disposableSigning, probeEnvironment } from "./probe-macos-adhoc-update.mjs";

const require = createRequire(import.meta.url);
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
    execFileSync(process.execPath, [require.resolve("electron-builder/cli.js"), "--projectDir", desktop,
      "--config", configurationPath, "--mac", `--${process.arch}`, "--publish", "never"],
    { env, stdio: "inherit", timeout: 600_000 });
  } finally {
    if (signing) await signing.cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageMac(process.argv.includes("--ci-probe"));
