import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { refreshMacMetadata } from "./finalize-macos-artifacts.mjs";

describe("[TC-PDDESKTOP-009] final notarized artifact metadata", () => {
  it("replaces pre-staple hashes and blockmaps with the final DMG bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdmux-stapled-metadata-"));
    try {
      const before = Buffer.from("disk image before stapling");
      const after = Buffer.concat([before, Buffer.from(" notarization ticket")]);
      const hash = bytes => createHash("sha512").update(bytes).digest("base64");
      await writeFile(join(directory, "app.dmg"), after);
      await writeFile(join(directory, "app.zip"), "stapled app zip");
      await writeFile(join(directory, "latest-mac.yml"), Bun.YAML.stringify({ version: "1.2.3", path: "app.dmg", sha512: hash(before), files: [{ url: "app.dmg", sha512: hash(before), size: before.length }, { url: "app.zip", sha512: "stale", size: 0 }] }));
      expect(hash(before)).not.toBe(hash(after));
      const metadata = await refreshMacMetadata(directory);
      expect(metadata.sha512).toBe(hash(after));
      expect(metadata.files[0].size).toBe(after.length);
      const blockmap = JSON.parse(gunzipSync(await readFile(join(directory, "app.dmg.blockmap"))));
      expect(blockmap.files[0].sizes.reduce((total, size) => total + size, 0)).toBe(after.length);
      expect(metadata.files[1].sha512).toBe(hash(Buffer.from("stapled app zip")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
