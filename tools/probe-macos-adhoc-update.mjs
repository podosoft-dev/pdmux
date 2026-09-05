#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function designatedRequirement(output) {
  const match = /^designated => (.+)$/m.exec(output);
  if (!match) throw new Error("Missing designated requirement; refusing to weaken signature verification");
  return match[1];
}

export function fixtureManifest(version, electronVersion, output) {
  return {
    name: "pdmux-update-probe", version, main: "main.cjs",
    description: "Disposable native update compatibility probe", author: "PDMUX", license: "Apache-2.0",
    build: {
      appId: "dev.podosoft.pdmux.updateprobe", productName: "PdmuxUpdateProbe",
      electronVersion, directories: { output }, files: ["main.cjs", "package.json"],
      artifactName: "probe-${version}-${arch}.${ext}",
      mac: { target: ["zip"], identity: "-", hardenedRuntime: true, notarize: false },
      publish: [{ provider: "generic", url: "http://localhost/" }],
    },
  };
}

export function fixtureSource(version) {
  return `const { app } = require('electron');
const { autoUpdater } = require(${JSON.stringify(require.resolve("electron-updater"))});
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PDMUX_PROBE_ROOT;
if (!root) throw new Error('Missing isolated probe root');
app.setPath('userData', path.join(root, 'user-data'));
const report = (event, detail) => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({event, detail, version: ${JSON.stringify(version)}}) + String.fromCharCode(10));
app.whenReady().then(async () => {
  report('ready', app.getVersion());
  if (app.getVersion() === '0.0.2') {
    if (fs.readFileSync(path.join(root, 'user-data', 'sentinel'), 'utf8') !== 'preserve-me') throw new Error('Lost data');
    report('updated', app.getVersion());
    app.quit();
    return;
  }
  fs.writeFileSync(path.join(root, 'user-data', 'sentinel'), 'preserve-me');
  autoUpdater.on('error', error => { report('error', error.message); app.exit(1); });
  autoUpdater.on('update-downloaded', () => {
    report('downloaded', app.getVersion());
    autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.setFeedURL({provider: 'generic', url: process.env.PDMUX_PROBE_FEED});
  await autoUpdater.checkForUpdates();
}).catch(error => { report('error', error.message); app.exit(1); });
`;
}

export async function probe() {
  if (process.platform !== "darwin") throw new Error("Native macOS is required; this probe cannot be validated on Linux");
  const root = await mkdtemp(join(tmpdir(), "pdmux-update-probe-"));
  const builder = require.resolve("electron-builder/cli.js");
  const desktop = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete env[key];
  let server;
  let child;
  try {
    for (const version of ["0.0.1", "0.0.2"]) {
      const source = join(root, version);
      await mkdir(source);
      await writeFile(join(source, "package.json"), JSON.stringify(fixtureManifest(version, desktop.devDependencies.electron, join(root, `out-${version}`))));
      await writeFile(join(source, "main.cjs"), fixtureSource(version));
      execFileSync(process.execPath, [builder, "--projectDir", source, "--mac", `--${process.arch}`, "--publish", "never"], { env, stdio: "inherit", timeout: 300_000 });
    }
    const apps = [];
    for (const version of ["0.0.1", "0.0.2"]) {
      const output = join(root, `out-${version}`);
      const zip = (await readdir(output)).find(name => name.endsWith(".zip"));
      assert.ok(zip, "A real update ZIP must be produced");
      const extracted = join(root, `extracted-${version}`);
      await mkdir(extracted);
      execFileSync("ditto", ["-x", "-k", join(output, zip), extracted]);
      const app = join(extracted, "PdmuxUpdateProbe.app");
      execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
      apps.push(app);
    }
    // This is the same old-app designated requirement used by Squirrel.Mac.
    const signature = spawnSync("codesign", ["-d", "-r-", apps[0]], { encoding: "utf8", timeout: 30_000 });
    assert.equal(signature.status, 0, "Read old-app code identity");
    const requirement = designatedRequirement(signature.stdout + signature.stderr);
    console.log(JSON.stringify({ stage: "old-app-requirement", requirement }));
    execFileSync("codesign", ["--verify", "--deep", "--strict", "-R", requirement, apps[1]], { stdio: "inherit" });

    const feedRoot = join(root, "out-0.0.2");
    const allowed = new Set((await readdir(feedRoot)).filter(name => /\.(yml|zip|blockmap)$/.test(name)));
    server = createServer(async (request, response) => {
      try {
        const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1));
        if (name !== basename(name) || !allowed.has(name)) { response.writeHead(404).end(); return; }
        const bytes = await readFile(join(feedRoot, name));
        response.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
      } catch { response.writeHead(500).end(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await mkdir(join(root, "user-data"));
    child = spawn(join(apps[0], "Contents/MacOS/PdmuxUpdateProbe"), [], {
      env: { ...env, PDMUX_PROBE_ROOT: root, PDMUX_PROBE_FEED: `http://127.0.0.1:${address.port}` }, stdio: "inherit",
    });
    child.on("error", error => console.error(error));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const events = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
      const rows = events.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const error = rows.find(row => row.event === "error");
      if (error) throw new Error(`Native updater failed: ${error.detail}`);
      if (rows.some(row => row.event === "updated" && row.version === "0.0.2")) {
        assert.ok(rows.some(row => row.event === "downloaded" && row.version === "0.0.1"));
        console.log(events);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Native updater did not relaunch the new version within 120 seconds");
  } finally {
    child?.kill("SIGTERM");
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    // A relaunched updater child may still use these files. The disposable CI VM owns cleanup.
    if (!child) await rm(root, { recursive: true, force: true });
    else console.error(`Retained isolated update fixture: ${root}`);
  }
}

if (import.meta.main) await probe();
