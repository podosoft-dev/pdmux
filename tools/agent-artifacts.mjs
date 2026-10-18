import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";
import { signingCommand, signingEnvironment, withAppleSigning } from "./apple-signing.mjs";

const repository = resolve(import.meta.dirname, "..");
export const agentTargets = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
const filename = target => `pdmux-agent-${target}`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function normalizeAgentPermissions(directory) {
  await chmod(directory, 0o755);
  for (const target of agentTargets) await chmod(join(directory, filename(target)), 0o755);
  for (const name of ["manifest.json", "SHA256SUMS"]) await chmod(join(directory, name), 0o644);
}

export async function verifyAgentDirectory(directory, { sourceDirectory, signed = false, native = false, subset = false } = {}) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "Invalid agent release version");
  assert.equal(manifest.artifacts?.length, agentTargets.length, "Require exactly four agent artifacts");
  const expectedCertificate = new X509Certificate(await readFile(join(repository, "apps/desktop/signing-certificate.pem")));
  const source = sourceDirectory ? JSON.parse(await readFile(join(sourceDirectory, "manifest.json"), "utf8")) : undefined;
  if (source) assert.equal(manifest.version, source.version, "Agent source version mismatch");
  let seed;
  if (subset) {
    seed = JSON.parse(await readFile(join(directory, "desktop-catalog.json"), "utf8")).seed;
    const expected = process.platform === "win32" ? null : `pdmux-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
    assert.equal(seed, expected, "Require the native desktop agent seed");
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith("pdmux-agent-")).sort(), seed ? [seed] : []);
  }
  const sums = [];
  for (const target of agentTargets) {
    const [os, arch] = target.split("-");
    const entries = manifest.artifacts.filter(entry => entry.os === os && entry.arch === arch);
    assert.equal(entries.length, 1, `Missing or duplicate agent: ${target}`);
    const entry = entries[0];
    assert.equal(entry.path, `/agent/${manifest.version}/${filename(target)}`, "Unsafe agent artifact path");
    const binary = join(directory, filename(target));
    const present = !subset || seed === filename(target);
    if (present) {
      const bytes = await readFile(binary);
      assert.equal(digest(bytes), entry.sha256, `Agent checksum mismatch: ${target}`);
      assert.equal(bytes.length, entry.bytes, `Agent size mismatch: ${target}`);
    }
    sums.push(`${entry.sha256}  ${filename(target)}`);
    if (signed) {
      assert.match(entry.sourceSha256 ?? "", /^[a-f0-9]{64}$/, "Missing reproducible source checksum");
      if (source) assert.equal(entry.sourceSha256, source.artifacts.find(item => item.os === os && item.arch === arch)?.sha256, "Agent source changed without a version update");
      if (os === "linux") assert.equal(entry.sha256, entry.sourceSha256, "Linux agent bytes must not change after source verification");
      else {
        assert.equal(entry.signing?.certificateSha256, expectedCertificate.fingerprint256, "Unexpected agent signing certificate");
        assert.ok(expectedCertificate.subject.split("\n").includes(`OU=${entry.signing?.teamId}`), "Unexpected agent signing team");
        if (native && present) await verifyMacAgent(binary, entry.signing);
      }
    }
  }
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), sums.join("\n") + "\n", "Agent checksum metadata mismatch");
  return manifest;
}

export async function verifyMacAgent(binary, signing) {
  assert.equal(process.platform, "darwin", "Native macOS signature verification is required");
  signingCommand("codesign", ["--verify", "--strict", "--all-architectures", "-R",
    `=anchor apple generic and certificate leaf[subject.OU] = "${signing.teamId}"`, binary]);
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-agent-certificate-"));
  try {
    const prefix = join(temporary, "certificate-");
    signingCommand("codesign", ["--display", `--extract-certificates=${prefix}`, binary]);
    const certificate = new X509Certificate(await readFile(`${prefix}0`));
    assert.equal(certificate.fingerprint256, signing.certificateSha256, "Agent certificate pin mismatch");
    const { spawnSync } = await import("node:child_process");
    const details = spawnSync("codesign", ["--display", "--verbose=4", binary], { encoding: "utf8" });
    assert.equal(details.status, 0, "Could not inspect agent signature");
    assert.match(details.stderr, /flags=.*runtime/, "Agent hardened runtime is required");
    assert.match(details.stderr, /Timestamp=/, "Agent secure timestamp is required");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function downloadPublishedAgent(version, directory) {
  const releases = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", "repos/podosoft-dev/pdmux/releases?per_page=100"], { encoding: "utf8", timeout: 60_000 })).flat();
  const scratch = await mkdtemp(join(tmpdir(), "pdmux-agent-lookup-"));
  try {
    for (const release of releases.filter(item => !item.draft && !item.prerelease && item.assets.some(asset => asset.name === "manifest.json"))) {
      execFileSync("gh", ["release", "download", release.tag_name, "--repo", "podosoft-dev/pdmux", "--pattern", "manifest.json", "--dir", scratch, "--clobber"], { stdio: "pipe", timeout: 60_000 });
      const manifest = JSON.parse(await readFile(join(scratch, "manifest.json"), "utf8"));
      if (manifest.version !== version) continue;
      assert.ok(manifest.artifacts.filter(entry => entry.os === "darwin").every(entry => entry.signing), "This agent version was already published unsigned; use a new agent version");
      await mkdir(directory, { recursive: true });
      for (const name of ["manifest.json", "SHA256SUMS", ...agentTargets.map(filename)]) {
        execFileSync("gh", ["release", "download", release.tag_name, "--repo", "podosoft-dev/pdmux", "--pattern", name, "--dir", directory, "--clobber"], { stdio: "pipe", timeout: 60_000 });
      }
      return true;
    }
    return false;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function prepareAgentArtifacts({ signed = false, local = false, outputRoot, cacheRoot } = {}) {
  assert.ok(outputRoot, "Pass an agent artifact output root");
  const version = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  const temporary = await mkdtemp(join(tmpdir(), "pdmux-agent-artifacts-"));
  const sourceRoot = join(temporary, "source");
  try {
    execFileSync(process.execPath, [join(repository, "tools/build-agent-binaries.mjs")], {
      cwd: repository, env: { ...signingEnvironment(process.env), PDMUX_AGENT_OUTPUT_ROOT: sourceRoot }, stdio: "inherit", timeout: 600_000,
    });
    const sourceDirectory = join(sourceRoot, version);
    const source = await verifyAgentDirectory(sourceDirectory);
    assert.equal(await readFile(join(sourceDirectory, "SHA256SUMS"), "utf8"),
      await readFile(join(repository, "apps/web/static/agent", version, "SHA256SUMS"), "utf8"), "Reproducible agent source checksums differ from the committed record");
    const target = join(resolve(outputRoot), version);
    if (!signed) {
      await rm(target, { recursive: true, force: true });
      await cp(sourceDirectory, target, { recursive: true });
      await normalizeAgentPermissions(target);
      await chmod(resolve(outputRoot), 0o755);
      return target;
    }
    return await withAppleSigning(async context => {
      const cache = join(cacheRoot ?? process.env.PDMUX_SIGNED_AGENT_CACHE ?? join(homedir(), ".cache/pdmux/signed-agents"), version);
      const published = join(temporary, "published");
      const found = await downloadPublishedAgent(version, published);
      let origin = "new";
      if (found) {
        origin = "published";
        await verifyAgentDirectory(published, { sourceDirectory, signed: true, native: true });
        await mkdir(cache, { recursive: true });
        await cp(published, cache, { recursive: true });
      } else if (await stat(join(cache, "manifest.json")).then(() => true, () => false)) {
        origin = "cache";
        await verifyAgentDirectory(cache, { sourceDirectory, signed: true, native: true });
      } else {
        const staging = join(temporary, "signed");
        await cp(sourceDirectory, staging, { recursive: true });
        for (const entry of source.artifacts) {
          entry.sourceSha256 = entry.sha256;
          const binary = join(staging, entry.path.split("/").pop());
          if (entry.os === "darwin") {
            context.sign(binary);
            entry.signing = { teamId: context.teamId, certificateSha256: context.certificateSha256 };
            await verifyMacAgent(binary, entry.signing);
          }
          const bytes = await readFile(binary);
          entry.sha256 = digest(bytes);
          entry.bytes = bytes.length;
        }
        const payload = join(temporary, "notarization.zip");
        const nativePayload = join(temporary, "native-agents");
        await mkdir(nativePayload);
        for (const target of agentTargets.filter(item => item.startsWith("darwin-"))) await cp(join(staging, filename(target)), join(nativePayload, filename(target)));
        signingCommand("ditto", ["-c", "-k", "--keepParent", nativePayload, payload]);
        await context.notarize(payload);
        await writeFile(join(staging, "manifest.json"), JSON.stringify(source, null, 2) + "\n");
        await writeFile(join(staging, "SHA256SUMS"), source.artifacts.map(entry => `${entry.sha256}  ${entry.path.split("/").pop()}`).join("\n") + "\n");
        await verifyAgentDirectory(staging, { sourceDirectory, signed: true, native: true });
        await mkdir(resolve(cache, ".."), { recursive: true });
        // Copy beside the cache and rename: a failed notarization never leaves a
        // reusable partial identity. The cache contains public release files only.
        const incoming = `${cache}.incoming-${process.pid}`;
        await cp(staging, incoming, { recursive: true });
        await rename(incoming, cache);
      }
      await rm(target, { recursive: true, force: true });
      await cp(cache, target, { recursive: true });
      await normalizeAgentPermissions(target);
      await chmod(resolve(outputRoot), 0o755);
      console.log(JSON.stringify({ stage: "signed-agent-artifacts", version, origin, result: "passed" }));
      return target;
    }, { local });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "verify") {
    await verifyAgentDirectory(resolve(args[1]), { signed: args.includes("--signed"), native: args.includes("--native"),
      sourceDirectory: args.includes("--source") ? resolve(args[args.indexOf("--source") + 1]) : undefined });
  } else {
    assert.ok(args.includes("--output"), "Pass --output <agent-root>");
    await prepareAgentArtifacts({ signed: args.includes("--signed"), local: args.includes("--local"), outputRoot: args[args.indexOf("--output") + 1] });
  }
}
