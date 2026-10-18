import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentCache } from "./agent-cache";
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ directory: string; data: Uint8Array<ArrayBuffer>; file: string }> {
  root = await mkdtemp(join(tmpdir(), "pdmux-agent-cache-"));
  const directory = join(root, "seed", "0.1.27"); await mkdir(directory, { recursive: true });
  const data = new TextEncoder().encode("verified-agent"); const file = "pdmux-agent-linux-amd64";
  await writeFile(join(directory, "desktop-catalog.json"), JSON.stringify({ version: 1, releaseTag: "v0.17.1", seed: null, repository: "podosoft-dev/pdmux" }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: "0.1.27", artifacts: ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map(target => ({ path: `/agent/0.1.27/pdmux-agent-${target}`, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })) }));
  return { directory, data, file };
}
it("[TC-PDDESKTOP-014] deduplicates downloads, verifies bytes, and repairs a corrupt cache", async () => {
  const { data, file } = await fixture(); let downloads = 0;
  const fetcher = (async () => { downloads += 1; await new Promise(resolve => setTimeout(resolve, 5)); return new Response(data); });
  const cache = new DesktopAgentCache(join(root, "seed"), join(root, "cache"), fetcher, () => true);
  const [first, second] = await Promise.all([cache.ensure("0.1.27", file), cache.ensure("0.1.27", file)]);
  expect(first).toBe(second); expect(downloads).toBe(1);
  await writeFile(first, "corrupted");
  await cache.ensure("0.1.27", file);
  expect([...await readFile(first)]).toEqual([...data]); expect(downloads).toBe(2);
});
it("[TC-PDDESKTOP-014] refuses a truncated download without publishing or leaving a partial file", async () => {
  const { file } = await fixture();
  const fetcher = (async () => new Response("short"));
  const cache = new DesktopAgentCache(join(root, "seed"), join(root, "cache"), fetcher, () => true);
  await expect(cache.ensure("0.1.27", file)).rejects.toMatchObject({ code: "DESKTOP_AGENT_INTEGRITY_FAILED" });
  expect(await readdir(join(root, "cache", "0.1.27"))).toEqual([]);
});
