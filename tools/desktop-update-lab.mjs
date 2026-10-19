import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signingEnvironment, signingCommand, withAppleSigning } from "./apple-signing.mjs";
import { prepareAgentArtifacts } from "./agent-artifacts.mjs";
import { macSigningConfiguration, runMacPackaging } from "./package-macos-desktop.mjs";

const repository = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
export const labDirectory = join(repository, "apps/desktop/release/local-update-lab");
export const labAppName = "pdmux-update-lab.app";
export const labVersions = ["0.0.1", "0.0.2"];

async function run(command, args, env = signingEnvironment(process.env)) {
  const started = Date.now();
  console.log(JSON.stringify({ stage: "local-update-command", command: basename(command), args, started: new Date(started).toISOString() }));
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: repository, env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? accept() : reject(new Error(`Local update command failed (${code})`)));
  });
  console.log(JSON.stringify({ stage: "local-update-command", finished: new Date().toISOString(), seconds: (Date.now() - started) / 1000 }));
}

/** This bootstrap exists only in disposable packages; the production shell is unchanged. */
export function labBootstrap() {
  return `import {app,dialog} from 'electron';
import updaterPackage from 'electron-updater';
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const config=JSON.parse(readFileSync(resolve(dirname(process.execPath),'../../../update-lab.json'),'utf8'));
if(!isAbsolute(config.root)||config.profile!==join(config.root,'profile')||new URL(config.feed).hostname!=='127.0.0.1')throw new Error('Invalid local update lab configuration');
if(process.argv.some(value=>value.startsWith('--user-data-dir')))throw new Error('The lab owns its isolated profile');
process.argv.push('--user-data-dir='+config.profile);
process.env.TMUX='';process.env.TMUX_TMPDIR=join(config.root,'tmux');mkdirSync(process.env.TMUX_TMPDIR,{recursive:true});
app.setAsDefaultProtocolClient=()=>false;
const report=(event,detail={})=>appendFileSync(join(config.root,'events.jsonl'),JSON.stringify({event,version:app.getVersion(),pid:process.pid,at:new Date().toISOString(),...detail})+'\\n');
const originalDialog=dialog.showMessageBox;
dialog.showMessageBox=async(...args)=>{const options=args.at(-1);report('dialog',{message:options.message,buttons:options.buttons});const result=process.env.PDMUX_UPDATE_LAB_AUTO_CONFIRM==='1'?{response:0,checkboxChecked:false}:await originalDialog.apply(dialog,args);report('dialog-result',{response:result.response});return result;};
const {autoUpdater}=updaterPackage;autoUpdater.setFeedURL({provider:'generic',url:config.feed});autoUpdater.disableDifferentialDownload=true;
autoUpdater.on('download-progress',progress=>report('progress',{percent:progress.percent}));
autoUpdater.on('error',error=>report('update-error',{message:error.message}));
app.on('browser-window-created',(_event,window)=>{window.webContents.on('page-title-updated',(event,title)=>{event.preventDefault();window.setTitle('[Update Lab '+app.getVersion()+'] '+title);});window.webContents.on('did-finish-load',()=>{if(!window.webContents.getURL().startsWith('http:'))return;void window.webContents.executeJavaScript("(async()=>({agent:await window.pdmuxDesktop.localAgent.status(),hosts:await(await fetch('/api/hosts')).json()}))()").then(detail=>{const secret=readFileSync(join(config.profile,'runtime/auth.secret'));report('ready',{...detail,secretHash:createHash('sha256').update(secret).digest('hex'),profile:config.profile,url:window.webContents.getURL()});}).catch(error=>report('runtime-error',{message:error.message}));});});
report('launch');
await import('./main.js');
app.setName('PDMux Update Lab');
`;
}

export function labConfiguration(base, identity, output, bootstrap, agents) {
  const config = macSigningConfiguration(base, identity, true);
  return { ...config, appId: "dev.podosoft.pdmux.update-lab", productName: "PDMux Update Lab", executableName: "pdmux-update-lab",
    directories: { ...base.directories, output }, protocols: [],
    extraMetadata: { name: "pdmux-update-lab", main: "dist/local-update-lab.mjs" },
    files: [...base.files, { from: bootstrap, to: "dist", filter: ["local-update-lab.mjs"] }],
    extraResources: [...base.extraResources.map(entry => entry.from === "resources/services/web" ? { ...entry, filter: [...(entry.filter ?? ["**/*"]), "!client/agent/**"] } : entry), { from: agents, to: `web/client/agent/${basename(agents)}` }],
    mac: { ...config.mac, target: ["zip"] }, publish: [{ provider: "generic", url: "http://127.0.0.1/" }],
  };
}

export async function buildLab() {
  assert.equal(process.platform, "darwin", "Build the update lab on a native Mac");
  assert.notEqual(process.env.GITHUB_ACTIONS, "true", "The local lab never publishes or runs release CI");
  await mkdir(labDirectory, { recursive: true });
  for (const name of ["@pdmux/desktop-protocol", "@pdmux/protocol", "@pdmux/core", "@pdmux/ui", "@pdmux/mcp"]) await run(process.execPath, ["run", "--filter", name, "build"]);
  await run(process.execPath, ["run", "desktop:prepare"]);
  await run(process.execPath, ["run", "--cwd", "apps/desktop", "build"]);
  const agents = await prepareAgentArtifacts({ signed: true, local: true, outputRoot: join(labDirectory, "agents") });
  const desktop = JSON.parse(await readFile(join(repository, "apps/desktop/package.json"), "utf8"));
  const bootstrap = join(labDirectory, "bootstrap"); await mkdir(bootstrap, { recursive: true });
  await writeFile(join(bootstrap, "local-update-lab.mjs"), labBootstrap());
  const builds = [];
  await withAppleSigning(async context => {
    for (const version of labVersions) {
      const output = join(labDirectory, `build-${version}`);
      await rm(output, { recursive: true, force: true });
      const config = labConfiguration(desktop.build, context.identity, output, bootstrap, agents);
      config.extraMetadata.version = version;
      const path = join(labDirectory, `builder-${version}.json`); await writeFile(path, JSON.stringify(config));
      const started = Date.now(); console.log(JSON.stringify({ stage: "lab-package", version, started: new Date().toISOString() }));
      await runMacPackaging("node", [require.resolve("electron-builder/cli.js"), "--projectDir", join(repository, "apps/desktop"), "--config", path, "--mac", `--${process.arch}`, "--publish", "never"], { ...context.env, CSC_FOR_PULL_REQUEST: "false" });
      const archive = (await readdir(output)).find(name => name.endsWith(".zip")); assert.ok(archive, "Missing local update ZIP");
      const bytes = await readFile(join(output, archive));
      builds.push({ version, directory: output, archive, sha512: createHash("sha512").update(bytes).digest("base64"), bytes: bytes.length });
      console.log(JSON.stringify({ stage: "lab-package", version, result: "passed", seconds: (Date.now() - started) / 1000 }));
    }
  }, { local: true });
  await writeFile(join(labDirectory, "lab.json"), JSON.stringify({ kind: "pdmux-update-lab", sourceVersion: desktop.version, builds }, null, 2));
  await writeFile(join(labDirectory, "channel.json"), JSON.stringify({ version: labVersions[0] }));
  await resetLab();
}

export async function readLab(directory = labDirectory) {
  const lab = JSON.parse(await readFile(join(directory, "lab.json"), "utf8"));
  assert.equal(lab.kind, "pdmux-update-lab", "Build the isolated update lab first");
  return lab;
}

export async function assertLabStopped(directory = labDirectory) {
  try {
    const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (const pid of new Set(events.filter(event => event.event === "launch").map(event => event.pid))) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "Invalid lab process record");
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
      assert.equal(alive, false, "Quit PDMux Update Lab before resetting its app");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function resetLab() {
  const lab = await readLab();
  await assertLabStopped();
  const first = lab.builds[0]; const archive = join(first.directory, first.archive);
  assert.equal(createHash("sha512").update(await readFile(archive)).digest("base64"), first.sha512, "The baseline archive was modified");
  const staging = join(labDirectory, "extract"); await rm(staging, { recursive: true, force: true }); await mkdir(staging);
  await run("ditto", ["-x", "-k", archive, staging]);
  const app = join(staging, labAppName); signingCommand("codesign", ["--verify", "--deep", "--strict", app]);
  // Squirrel can make the replacement root-owned. Retire its containing directory,
  // rather than modifying the signed app, and preserve the active loopback feed.
  const installed = join(labDirectory, "installed");
  let feedConfiguration;
  try { feedConfiguration = await readFile(join(installed, "update-lab.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const retired = join(labDirectory, "retired"); await mkdir(retired, { recursive: true });
  try { await rename(installed, join(retired, String(Date.now()))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(installed);
  if (feedConfiguration) await writeFile(join(installed, "update-lab.json"), feedConfiguration, { mode: 0o600 });
  await rename(app, join(installed, labAppName)); await rm(staging, { recursive: true });
  console.log(JSON.stringify({ stage: "lab-reset", app: join(labDirectory, "installed", labAppName), profilePreserved: true }));
}

export async function serveLab({ directory = labDirectory, speed = 4 * 1_048_576, metadataDelay = 1500 } = {}) {
  const lab = await readLab(directory);
  const artifacts = new Map();
  for (const build of lab.builds) for (const name of await readdir(build.directory)) if (/\.(zip|blockmap)$/.test(name)) artifacts.set(name, join(build.directory, name));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ kind: lab.kind })); return; }
      if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const name = decodeURIComponent(url.pathname.slice("/feed/".length));
      if (!url.pathname.startsWith("/feed/") || name !== basename(name)) { response.writeHead(404); response.end(); return; }
      let path = artifacts.get(name);
      if (name === "latest-mac.yml") {
        const selected = JSON.parse(await readFile(join(directory, "channel.json"), "utf8")).version;
        const build = lab.builds.find(item => item.version === selected); assert.ok(build, "Unknown lab channel");
        path = join(build.directory, name);
        await new Promise(resolve => setTimeout(resolve, metadataDelay));
      }
      if (!path) { response.writeHead(404); response.end(); return; }
      const size = (await stat(path)).size;
      let start = 0; let end = size - 1;
      if (request.headers.range) {
        const range = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (!range || (start = Number(range[1])) >= size || (end = range[2] ? Math.min(Number(range[2]), end) : end) < start) { response.writeHead(416, { "content-range": `bytes */${size}` }); response.end(); return; }
      }
      response.writeHead(request.headers.range ? 206 : 200, { "content-type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream", "content-length": end - start + 1, "accept-ranges": "bytes", "cache-control": "no-store", ...(request.headers.range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
      if (request.method === "HEAD") { response.end(); return; }
      for await (const bytes of createReadStream(path, { start, end, highWaterMark: 64 * 1024 })) {
        if (response.destroyed) break;
        if (!response.write(bytes)) await new Promise(resolve => { const done = () => { response.off("drain", done); response.off("close", done); resolve(); }; response.once("drain", done); response.once("close", done); });
        if (speed > 0 && name.endsWith(".zip")) await new Promise(resolve => setTimeout(resolve, bytes.length / speed * 1000));
      }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(join(directory, "installed"), { recursive: true });
  await writeFile(join(directory, "installed/update-lab.json"), JSON.stringify({ root: directory, profile: join(directory, "profile"), feed: `${origin}/feed/` }), { mode: 0o600 });
  await writeFile(join(directory, "server.json"), JSON.stringify({ origin, pid: process.pid, speed }));
  return { server, origin, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === "build") await buildLab();
  else if (action === "reset") await resetLab();
  else if (action === "publish") { assert.ok(labVersions.includes(process.argv[3]), "Choose 0.0.1 or 0.0.2"); await writeFile(join(labDirectory, "channel.json"), JSON.stringify({ version: process.argv[3] })); console.log(`Local feed now publishes ${process.argv[3]}`); }
  else if (action === "serve") { const lab = await serveLab(); console.log(JSON.stringify({ stage: "lab-server", origin: lab.origin, directory: labDirectory })); process.once("SIGINT", () => { void lab.close(); }); process.once("SIGTERM", () => { void lab.close(); }); }
  else if (action === "open") {
    await readLab(); const child = spawn(join(labDirectory, "installed", labAppName, "Contents/MacOS/pdmux-update-lab"), [], { detached: true, stdio: "ignore", env: signingEnvironment(process.env) }); child.unref();
  } else throw new Error("Usage: desktop-update-lab.mjs build | serve | publish <0.0.1|0.0.2> | open | reset");
}
