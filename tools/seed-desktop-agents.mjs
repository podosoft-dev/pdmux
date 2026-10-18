import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Preserve the canonical release catalog; only the packaged binary subset changes. */
export async function seedDesktopAgents(directory, { platform = process.platform, arch = process.arch, releaseTag } = {}) {
  assert.match(releaseTag, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  const target = os && cpu ? `pdmux-agent-${os}-${cpu}` : null;
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.length, 5);
  for (const artifact of manifest.artifacts) {
    const name = artifact.path.split("/").pop();
    assert.match(name, /^pdmux-agent-(linux|darwin|windows)-(amd64|arm64)$/);
    assert.equal(artifact.path, `/agent/${manifest.version}/${name}`);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
  }
  if (target) await readFile(join(directory, target));
  await writeFile(join(directory, "desktop-catalog.json"), JSON.stringify({ version: 1, releaseTag, seed: target, repository: "podosoft-dev/pdmux" }) + "\n");
  for (const name of await readdir(directory)) if (name.startsWith("pdmux-agent-") && name !== target) await rm(join(directory, name));
}
if (import.meta.main) await seedDesktopAgents(process.argv[2], { releaseTag: process.argv[3] });
