import { describe, expect, it } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTargets, normalizeAgentPermissions, verifyAgentDirectory } from "./agent-artifacts.mjs";

describe("[TC-PDDESKTOP-009] canonical signed agent artifacts", () => {
  async function fixture(directory) {
    const certificate = new X509Certificate(await readFile(new URL("../apps/desktop/signing-certificate.pem", import.meta.url)));
    const teamId = certificate.subject.split("\n").find(value => value.startsWith("OU=")).slice(3);
    const artifacts = [];
    for (const target of agentTargets) {
      const [os, arch] = target.split("-");
      const bytes = Buffer.from(target);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const name = `pdmux-agent-${target}`;
      await writeFile(join(directory, name), bytes);
      artifacts.push({ os, arch, path: `/agent/1.2.3/${name}`, bytes: bytes.length, sha256, sourceSha256: sha256,
        ...(os === "darwin" ? { signing: { teamId, certificateSha256: certificate.fingerprint256 } } : {}) });
    }
    const manifest = { version: "1.2.3", artifacts };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "SHA256SUMS"), artifacts.map(entry => `${entry.sha256}  ${entry.path.split("/").pop()}`).join("\n") + "\n");
    return manifest;
  }
  it("rejects tampered binaries, stale source hashes, and rotated signing identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdmux-agent-integrity-"));
    const source = await mkdtemp(join(tmpdir(), "pdmux-agent-source-"));
    try {
      const manifest = await fixture(root);
      await fixture(source);
      await expect(verifyAgentDirectory(root, { signed: true, sourceDirectory: source })).resolves.toEqual(manifest);
      manifest.artifacts[2].sourceSha256 = "0".repeat(64);
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyAgentDirectory(root, { signed: true, sourceDirectory: source })).rejects.toThrow("source changed without a version update");
      await fixture(root);
      const badPin = await fixture(root);
      badPin.artifacts[2].signing.certificateSha256 = "00";
      await writeFile(join(root, "manifest.json"), JSON.stringify(badPin));
      await expect(verifyAgentDirectory(root, { signed: true })).rejects.toThrow("Unexpected agent signing certificate");
      await fixture(root);
      await writeFile(join(root, "pdmux-agent-darwin-arm64"), "tampered");
      await expect(verifyAgentDirectory(root, { signed: true })).rejects.toThrow("Agent checksum mismatch");
    } finally { await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
  });
  it("rejects duplicate targets and unsigned Darwin release metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdmux-agent-metadata-"));
    try {
      const manifest = await fixture(root);
      delete manifest.artifacts[2].signing;
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyAgentDirectory(root, { signed: true })).rejects.toThrow("Unexpected agent signing certificate");
      manifest.artifacts[3] = manifest.artifacts[2];
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(verifyAgentDirectory(root)).rejects.toThrow("Missing or duplicate agent");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps public artifacts readable by a non-root runtime after a private secret-store umask", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pdmux-agent-permissions-"));
    try {
      await fixture(root);
      for (const name of ["manifest.json", "SHA256SUMS", ...agentTargets.map(target => `pdmux-agent-${target}`)]) await chmod(join(root, name), 0o600);
      await chmod(root, 0o700);
      expect((await stat(join(root, "manifest.json"))).mode & 0o044).toBe(0);
      await normalizeAgentPermissions(root);
      expect((await stat(root)).mode & 0o777).toBe(0o755);
      expect((await stat(join(root, "manifest.json"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(root, "pdmux-agent-darwin-arm64"))).mode & 0o777).toBe(0o755);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
