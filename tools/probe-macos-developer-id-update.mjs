import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertCertificate, signingCommand, withAppleSigning } from "./apple-signing.mjs";
import { fixtureManifest, fixtureSource, probe, probeEnvironment } from "./probe-macos-adhoc-update.mjs";
import { runMacPackaging } from "./package-macos-desktop.mjs";

const require = createRequire(import.meta.url);

export async function prepareUpdateProbe({ local = false } = {}) {
  assert.ok(process.env.PDMUX_PROBE_ARCHIVES, "Pass a disposable probe archive directory");
  const archives = resolve(process.env.PDMUX_PROBE_ARCHIVES);
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-developer-id-probe-"));
  const desktop = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
  try {
    await withAppleSigning(async context => {
      for (const version of ["0.0.1", "0.0.2", "0.0.3"]) {
        const source = join(temporary, version);
        await mkdir(source);
        const manifest = fixtureManifest(version, desktop.devDependencies.electron, join(archives, `out-${version}`), version === "0.0.3" ? "-" : context.identity);
        await writeFile(join(source, "package.json"), JSON.stringify(manifest));
        await writeFile(join(source, "main.cjs"), fixtureSource(version));
        const env = { ...probeEnvironment(context.env), CSC_KEYCHAIN: context.env.CSC_KEYCHAIN, CSC_FOR_PULL_REQUEST: "false" };
        await runMacPackaging("node", [require.resolve("electron-builder/cli.js"), "--projectDir", source, "--mac", `--${process.arch}`, "--publish", "never"], env);
      }
    }, { local });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  if (process.argv.includes("--prepare")) await prepareUpdateProbe({ local: process.argv.includes("--local") });
  else {
    assert.ok(process.argv.includes("--verify"), "Pass --prepare or --verify");
    // This process has no imported identity: real Squirrel.Mac checks the old
    // Developer ID requirement, rejects an ad-hoc impostor and tampered payload,
    // then downloads, installs, relaunches and checks preserved fixture data.
    const temporary = await mkdtemp(join(tmpdir(), "pdmux-probe-certificates-"));
    try {
      await probe("verify", { verifyApp: async (app, version) => {
        if (version === "0.0.3") return;
        const prefix = join(temporary, `${version}-`);
        signingCommand("codesign", ["--display", `--extract-certificates=${prefix}`, app]);
        assertCertificate(await readFile(`${prefix}0`), await readFile(new URL("../apps/desktop/signing-certificate.pem", import.meta.url)));
      } });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
