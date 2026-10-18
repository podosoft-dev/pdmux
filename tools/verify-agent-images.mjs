import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";
import { verifyAgentDirectory } from "./agent-artifacts.mjs";

export async function verifyAgentImages(api, web, agentRoot) {
  for (const image of [api, web]) assert.ok(image && !image.startsWith("-") && !/\s/.test(image), "Pass two exact image references");
  const version = parseAgentVersion(await readFile(new URL("../agent/internal/cli/version.go", import.meta.url), "utf8"));
  const manifest = await verifyAgentDirectory(join(agentRoot, version), { signed: true });
  const run = args => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  const apiManifest = run(["run", "--rm", "--network", "none", "--entrypoint", "bun", api, "-e",
    `console.log(await Bun.file(${JSON.stringify(`/app/agent-releases/${version}/manifest.json`)}).text())`]);
  assert.deepEqual(JSON.parse(apiManifest), manifest, "The API runtime user must read the canonical release manifest");
  const root = `/app/apps/web/build/client/agent/${version}`;
  const inspect = `const {createHash}=await import("node:crypto");const root=${JSON.stringify(root)};
    const manifest=await Bun.file(root+"/manifest.json").json();
    for(const entry of manifest.artifacts){
      const bytes=Buffer.from(await Bun.file(root+"/"+entry.path.split("/").pop()).arrayBuffer());
      entry.sha256=createHash("sha256").update(bytes).digest("hex");entry.bytes=bytes.length;
    }console.log(JSON.stringify(manifest));`;
  assert.deepEqual(JSON.parse(run(["run", "--rm", "--network", "none", "--entrypoint", "bun", web, "-e", inspect])), manifest,
    "The web runtime user must read the actual canonical agent bytes");
  const name = `pdmux-agent-image-check-${randomUUID()}`;
  try {
    run(["run", "-d", "--name", name, "--network", "none", web]);
    const http = `const {createHash}=await import("node:crypto");
      for(let attempt=0;attempt<30;attempt++){
        try{if((await fetch("http://127.0.0.1:3000/healthz")).ok)break;}catch{}
        await Bun.sleep(200);
      }
      const manifest=await Bun.file(${JSON.stringify(`${root}/manifest.json`)}).json();
      for(const entry of manifest.artifacts){
        const response=await fetch("http://127.0.0.1:3000"+entry.path);
        if(!response.ok)throw Error("Agent HTTP status "+response.status);
        const bytes=Buffer.from(await response.arrayBuffer());
        if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw Error("Agent HTTP checksum mismatch");
      }
      const response=await fetch("http://127.0.0.1:3000/install.sh");
      if(!response.ok)throw Error("Installer HTTP status "+response.status);
      const installer=await response.text();
      for(const entry of manifest.artifacts)if(!installer.includes(entry.sha256))throw Error("Installer checksum mismatch");`;
    run(["exec", name, "bun", "-e", http]);
  } finally { run(["rm", "-f", name]); }
  console.log(JSON.stringify({ stage: "verify-agent-images", version, binaries: manifest.artifacts.length, runtimeUserAndHttp: "passed" }));
}

if (import.meta.main) {
  assert.ok(process.argv[4], "Usage: verify-agent-images.mjs <api-image> <web-image> <canonical-agent-root>");
  await verifyAgentImages(process.argv[2], process.argv[3], resolve(process.argv[4]));
}
