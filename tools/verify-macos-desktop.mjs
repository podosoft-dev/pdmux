#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";
import { assertCertificate } from "./release-macos-signing.mjs";

const repository = resolve(import.meta.dirname, "..");
const agentNames = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map(arch => `pdmux-agent-${arch}`);

export function certificateExtractionArguments(prefix, app) {
  return ["--display", `--extract-certificates=${prefix}`, app];
}

export function parseAgentChecksums(text) {
  const entries = text.trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})\s+\*?(pdmux-agent-(?:linux|darwin)-(?:amd64|arm64))$/.exec(line);
    assert.ok(match, "Invalid agent checksum entry");
    return [match[2], match[1]];
  });
  assert.deepEqual(entries.map(([name]) => name).sort(), [...agentNames].sort(), "Require exactly the four published agents");
  return entries;
}

export async function verifyAgentResources(resources, referenceDirectory) {
  const reference = await readFile(join(referenceDirectory, "SHA256SUMS"), "utf8");
  assert.equal(await readFile(join(resources, "SHA256SUMS"), "utf8"), reference, "Packaged agent checksum metadata changed");
  for (const [name, expected] of parseAgentChecksums(reference)) {
    const hash = createHash("sha256").update(await readFile(join(resources, name))).digest("hex");
    assert.equal(hash, expected, `Packaged agent bytes changed: ${name}`);
  }
}

async function verifyApp(app) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--all-architectures", app], { stdio: "inherit", timeout: 60_000 });
  const resources = join(app, "Contents/Resources");
  const bun = join(resources, "bin/bun");
  execFileSync("codesign", ["--verify", "--strict", bun], { stdio: "inherit", timeout: 30_000 });
  const result = execFileSync(bun, ["-e", 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(JSON.stringify({arch:process.arch,answer:db.query("select 42 as answer").get().answer})); db.close();'], { encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(JSON.parse(result.trim()), { arch: process.arch, answer: 42 });
  const version = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  await verifyAgentResources(join(resources, "web/client/agent", version), join(repository, "apps/web/static/agent", version));
}

export async function verifyMacArtifacts(directory, runtime = false) {
  assert.equal(process.platform, "darwin", "Native macOS artifact verification is required");
  const files = await readdir(directory);
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-mac-verify-"));
  let mounted = false;
  try {
    for (const extension of ["zip", "dmg"]) {
      const matches = files.filter(name => name.endsWith(`.${extension}`));
      assert.equal(matches.length, 1, `Require exactly one ${extension} for this native architecture`);
      const artifact = join(directory, matches[0]);
      const extracted = join(temporary, extension);
      await mkdir(extracted);
      if (extension === "zip") {
        execFileSync("ditto", ["-x", "-k", artifact, extracted]);
      } else {
        const mount = join(temporary, "mount");
        await mkdir(mount);
        execFileSync("hdiutil", ["verify", artifact], { stdio: "inherit", timeout: 60_000 });
        execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, artifact], { stdio: "inherit", timeout: 60_000 });
        mounted = true;
        try { execFileSync("ditto", [join(mount, "pdmux.app"), join(extracted, "pdmux.app")]); }
        finally {
          execFileSync("hdiutil", ["detach", mount], { stdio: "inherit", timeout: 30_000 });
          mounted = false;
        }
      }
      const app = join(extracted, "pdmux.app");
      await verifyApp(app);
      // Exercise certificate extraction for disposable PR builds too, so the
      // native argument contract cannot fail for the first time after tagging.
      const prefix = join(extracted, "signer-");
      execFileSync("codesign", certificateExtractionArguments(prefix, app), { stdio: "inherit", timeout: 30_000 });
      const certificate = new X509Certificate(await readFile(`${prefix}0`));
      assert.ok(Date.parse(certificate.validTo) > Date.now(), "Package signing certificate has expired");
      if (process.env.PDMUX_VERIFY_RELEASE_IDENTITY === "1") {
        assertCertificate(certificate.raw, await readFile(join(repository, "apps/desktop/signing-certificate.pem")));
      }
      console.log(JSON.stringify({ stage: "package-certificate", fingerprint: certificate.fingerprint256, result: "passed" }));
      if (runtime) {
        await new Promise((resolve, reject) => {
          const child = spawn("node", [join(repository, "tools/smoke-macos-desktop.mjs"), app,
            join(directory, `desktop-${extension}.png`), ...(extension === "dmg" ? ["--expect-preserved"] : [])],
          { stdio: "inherit", timeout: 180_000 });
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Packaged runtime failed (${code})`)));
        });
      }
      console.log(JSON.stringify({ stage: "verify-final-mac-package", format: extension, arch: process.arch, result: "passed" }));
    }
  } finally {
    if (!mounted) await rm(temporary, { recursive: true, force: true });
    else console.error(`Retained fixture with an attached read-only disk image: ${temporary}`);
  }
}

if (import.meta.main) {
  assert.ok(process.argv[2], "Pass the directory containing one native DMG and ZIP");
  await verifyMacArtifacts(resolve(process.argv[2]), process.argv.includes("--runtime"));
}
