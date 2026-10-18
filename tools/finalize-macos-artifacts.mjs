import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { signingCommand } from "./apple-signing.mjs";

const require = createRequire(import.meta.url);

export async function refreshMacMetadata(directory) {
  const path = join(directory, "latest-mac.yml");
  const metadata = Bun.YAML.parse(await readFile(path, "utf8"));
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0, "Missing macOS update files");
  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
  for (const file of metadata.files) {
    assert.equal(file.url, basename(file.url), "Unsafe macOS update artifact path");
    const artifact = join(directory, file.url);
    if (file.url.endsWith(".dmg")) await buildBlockMap(artifact, "gzip", `${artifact}.blockmap`);
    const bytes = await readFile(artifact);
    file.sha512 = createHash("sha512").update(bytes).digest("base64");
    file.size = bytes.length;
  }
  const primary = metadata.files.find(file => file.url === metadata.path);
  assert.ok(primary, "Primary macOS update artifact is missing");
  metadata.sha512 = primary.sha512;
  await writeFile(path, Bun.YAML.stringify(metadata));
  return metadata;
}

export async function finalizeMacArtifacts(directory, context) {
  const dmgs = (await readdir(directory)).filter(name => name.endsWith(".dmg"));
  assert.equal(dmgs.length, 1, "Require one native DMG before finalization");
  const dmg = join(directory, dmgs[0]);
  await context.notarize(dmg);
  signingCommand("xcrun", ["stapler", "staple", dmg], { env: context.env });
  signingCommand("xcrun", ["stapler", "validate", dmg], { env: context.env });
  signingCommand("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg], { env: context.env });
  // Stapling changes the DMG: recreate its blockmap and hashes only afterwards.
  await refreshMacMetadata(directory);
}
