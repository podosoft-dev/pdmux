import { describe, it, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { macSigningConfiguration } from "./package-macos-desktop.mjs";
import { parseAgentChecksums, verifyAgentResources } from "./verify-macos-desktop.mjs";

describe("[TC-PDDESKTOP-009] signed product package integrity", () => {
  it("requires a stable identity and preserves shared packaging settings", () => {
    const base = { appId: "fixture", mac: { target: ["dmg", "zip"] }, files: ["dist/**"] };
    const config = macSigningConfiguration(base, "Fixture Certificate");
    expect(config.mac.identity).toBe("Fixture Certificate");
    expect(config.mac.target).toEqual(["dmg", "zip"]);
    expect(config.files).toEqual(base.files);
    expect(config.forceCodeSigning).toBe(true);
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.strictVerify).toBe(true);
    expect(config.mac.notarize).toBe(false);
    expect(config.mac.binaries).toEqual(["Contents/Resources/bin/bun"]);
    expect(base.mac.identity).toBeUndefined();
    for (const identity of [undefined, "", " ", "-"]) expect(() => macSigningConfiguration(base, identity)).toThrow();
  });
  it("excludes only downloadable agents from re-signing", () => {
    const pattern = new RegExp(macSigningConfiguration({}, "Fixture").mac.signIgnore[0]);
    const prefix = "/tmp/pdmux.app/Contents/Resources/";
    expect(pattern.test(`${prefix}web/client/agent/0.1.0/pdmux-agent-darwin-arm64`)).toBe(true);
    expect(pattern.test(`${prefix}bin/bun`)).toBe(false);
    expect(pattern.test(`${prefix}web/client/agent/0.1.0/other-helper`)).toBe(false);
    expect(pattern.test(`${prefix}web/client/agent/0.1.0/pdmux-agent-darwin-arm64/child`)).toBe(false);
  });
  it("rejects incomplete, duplicate, and unsafe checksum entries", () => {
    const line = `${"a".repeat(64)}  pdmux-agent-linux-amd64`;
    expect(() => parseAgentChecksums(line)).toThrow();
    expect(() => parseAgentChecksums(Array(4).fill(line).join("\n"))).toThrow();
    expect(() => parseAgentChecksums(`${"a".repeat(64)}  ../agent`)).toThrow();
  });
  it("detects re-signed agent bytes even when packaged checksums are unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdmux-agent-signing-test-"));
    const resources = join(root, "resources");
    const reference = join(root, "reference");
    try {
      await mkdir(resources);
      await mkdir(reference);
      const names = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map(arch => `pdmux-agent-${arch}`);
      const hash = createHash("sha256").update("original").digest("hex");
      const sums = names.map(name => `${hash}  ${name}`).join("\n");
      await writeFile(join(reference, "SHA256SUMS"), sums);
      await writeFile(join(resources, "SHA256SUMS"), sums);
      for (const name of names) await writeFile(join(resources, name), "original");
      await expect(verifyAgentResources(resources, reference)).resolves.toBeUndefined();
      await writeFile(join(resources, names[3]), "re-signed");
      await expect(verifyAgentResources(resources, reference)).rejects.toThrow("Packaged agent bytes changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
