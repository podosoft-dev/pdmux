#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { disposableSigning, probeEnvironment } from "./probe-macos-adhoc-update.mjs";

const repository = resolve(import.meta.dirname, "..");

export async function runMacPackaging(command, args, env) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", line => {
      if (/Developer ID Application:|Authority=/.test(line)) console.log("Verified Developer ID signing identity");
      else console.log(line);
    });
    child.once("error", () => reject(new Error("Could not start native macOS packaging")));
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`Native macOS packaging failed (${code})`)));
  });
}

export function macSigningConfiguration(base, identity, notarize = false) {
  assert.ok(typeof identity === "string" && identity.trim() && identity !== "-", "A stable certificate identity is required; ad-hoc signing cannot update safely");
  return {
    ...base,
    forceCodeSigning: true,
    mac: {
      ...base.mac, identity, notarize, hardenedRuntime: true, strictVerify: true,
      binaries: ["Contents/Resources/bin/bun"],
      // Downloadable agents have immutable checksums and are resources, not app helpers.
      signIgnore: ["/Contents/Resources/web/client/agent/[^/]+/pdmux-agent-(linux|darwin)-(amd64|arm64)$"],
    },
    dmg: { ...base.dmg, sign: notarize },
  };
}

export function macPackagingArguments(desktop, configurationPath, arch) {
  assert.ok(arch === "arm64" || arch === "x64", "Unsupported macOS architecture");
  // Let the existing package script honor electron-builder's Node shebang.
  // Direct Bun execution hangs in its portable WASM icon converter.
  return ["run", "--cwd", desktop, "package", "--", "--config", configurationPath,
    "--mac", `--${arch}`, "--publish", "never"];
}

export async function packageMac(ciProbe = false, context) {
  assert.equal(process.platform, "darwin", "Native macOS packaging is required");
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-mac-package-"));
  let signing;
  try {
    if (ciProbe) signing = await disposableSigning(temporary);
    const environment = context?.env ?? process.env;
    const identity = signing?.identities[0] ?? environment.PDMUX_MAC_SIGNING_IDENTITY;
    const keychain = signing?.keychain ?? environment.CSC_KEYCHAIN;
    assert.ok(keychain, "An explicitly provisioned signing keychain is required");
    const desktop = join(repository, "apps/desktop");
    const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
    const configuration = macSigningConfiguration(manifest.build, identity, Boolean(context));
    const configurationPath = join(temporary, "builder.json");
    await writeFile(configurationPath, JSON.stringify(configuration));
    const env = {
      ...probeEnvironment(environment), CSC_KEYCHAIN: keychain,
      CSC_FOR_PULL_REQUEST: ciProbe ? "true" : "false",
    };
    if (context) {
      for (const key of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
        assert.ok(environment[key], `Notarization requires ${key}`);
        env[key] = environment[key];
      }
    }
    await runMacPackaging(process.execPath, macPackagingArguments(desktop, configurationPath, process.arch), env);
  } finally {
    if (signing) await signing.cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageMac(process.argv.includes("--ci-probe"));
