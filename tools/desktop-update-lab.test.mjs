import { afterEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { assertLabStopped, labBootstrap, labConfiguration, labVersions, serveLab } from "./desktop-update-lab.mjs";

let directory;
let feed;
afterEach(async () => { await feed?.close(); feed = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "pdmux-update-lab-test-"));
  const builds = [];
  for (const version of labVersions) {
    const path = join(directory, version); await mkdir(path);
    await writeFile(join(path, "latest-mac.yml"), `version: ${version}\n`);
    await writeFile(join(path, `${version}.zip`), "0123456789");
    await writeFile(join(path, "private.json"), "must not be served");
    builds.push({ version, directory: path });
  }
  await writeFile(join(directory, "lab.json"), JSON.stringify({ kind: "pdmux-update-lab", builds }));
  await writeFile(join(directory, "channel.json"), JSON.stringify({ version: "0.0.1" }));
  feed = await serveLab({ directory, speed: 0, metadataDelay: 0 });
  return feed.origin;
}
it("[TC-PDDESKTOP-008] switches a loopback update feed between baseline and candidate", async () => {
  const origin = await fixture(); expect(new URL(origin).hostname).toBe("127.0.0.1");
  expect(await (await fetch(origin+"/feed/latest-mac.yml")).text()).toContain("0.0.1");
  await writeFile(join(directory, "channel.json"), JSON.stringify({ version: "0.0.2" }));
  expect(await (await fetch(origin+"/feed/latest-mac.yml")).text()).toContain("0.0.2");
});
it("[TC-PDDESKTOP-008] serves actual archives, HEAD and bounded byte ranges", async () => {
  const origin = await fixture();
  expect(await (await fetch(origin+"/feed/0.0.2.zip")).text()).toBe("0123456789");
  const head = await fetch(origin+"/feed/0.0.2.zip", { method:"HEAD" });
  expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
  const partial = await fetch(origin+"/feed/0.0.2.zip", { headers:{range:"bytes=2-5"} });
  expect(partial.status).toBe(206); expect(await partial.text()).toBe("2345");
  expect((await fetch(origin+"/feed/0.0.2.zip", {headers:{range:"bytes=10-"}})).status).toBe(416);
});
it("[TC-PDDESKTOP-008] exposes only update metadata and archives", async () => {
  const origin = await fixture();
  for (const path of ["/feed/private.json", "/feed/../lab.json", "/feed/%2e%2e%2flab.json", "/installed/update-lab.json"]) expect((await fetch(origin+path)).status).toBe(404);
  expect((await fetch(origin+"/feed/latest-mac.yml", {method:"POST"})).status).toBe(405);
});
it("[TC-PDDESKTOP-009] packages isolated test versions without changing product identity or protocols", () => {
  const base={appId:"production",protocols:[{schemes:["production"]}],files:["dist/**"],extraResources:[],mac:{},directories:{}};
  const config=labConfiguration(base,"stable-certificate","/tmp/output","/tmp/bootstrap","/tmp/agents/1.0.0");
  expect(config.appId).toBe("dev.podosoft.pdmux.update-lab"); expect(config.protocols).toEqual([]);
  expect(config.mac.notarize).toBe(false); expect(config.afterSign).toMatch(/tools\/notarize-macos-app\.mjs$/); expect(config.mac.identity).toBe("stable-certificate");
  expect(base.appId).toBe("production"); expect(base.protocols).toHaveLength(1);
  expect(labBootstrap()).toContain("--user-data-dir="); expect(labBootstrap()).toContain("setAsDefaultProtocolClient=()=>false");
});
it("[TC-PDDESKTOP-008] records separately parseable events in the packaged bootstrap", () => {
  let output = "";
  const report = labBootstrap().split("\n").find(line => line.startsWith("const report="));
  runInNewContext(report + "\nreport('launch');report('progress',{percent:42});", {
    appendFileSync: (_path, value) => { output += value; }, join, config: {root:"/tmp/lab"}, app: {getVersion:()=>"0.0.1"}, process: {pid:123},
  });
  expect(output.trim().split("\n").map(line=>JSON.parse(line).event)).toEqual(["launch","progress"]);
});
it("[TC-PDDESKTOP-008] refuses reset while an earlier lab instance remains running", async () => {
  await fixture();
  await writeFile(join(directory,"events.jsonl"),JSON.stringify({event:"launch",pid:process.pid})+"\n"+JSON.stringify({event:"launch",pid:2147483647})+"\n");
  await expect(assertLabStopped(directory)).rejects.toThrow("Quit PDMux Update Lab");
  await writeFile(join(directory,"events.jsonl"),"");
  await assertLabStopped(directory);
});
