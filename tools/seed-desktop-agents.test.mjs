import { afterEach, expect, it } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDesktopAgents } from "./seed-desktop-agents.mjs";
let directory;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it("[TC-PDDESKTOP-014] ships one native binary without changing canonical checksums", async () => {
  directory = await mkdtemp(join(tmpdir(), "pdmux-agent-seed-"));
  const names = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
  const manifest = { version: "0.1.27", artifacts: names.map(target => ({ path: `/agent/0.1.27/pdmux-agent-${target}`, sha256: "a".repeat(64), bytes: 4 })) };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "SHA256SUMS"), "canonical");
  for (const name of names) await writeFile(join(directory, `pdmux-agent-${name}`), "test");
  await seedDesktopAgents(directory, { platform: "darwin", arch: "arm64", releaseTag: "v0.17.1" });
  expect((await readdir(directory)).filter(name => name.startsWith("pdmux-agent-"))).toEqual(["pdmux-agent-darwin-arm64"]);
  expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe("canonical");
  expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))).toEqual(manifest);
});
