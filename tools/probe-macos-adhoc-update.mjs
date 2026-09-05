#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);

export function probeEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(CSC_|WIN_CSC_|APPLE_)/.test(key)) delete env[key];
  }
  // Only disposable fixtures may sign in a PR; never forward real credentials.
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_FOR_PULL_REQUEST: "true" };
}

export function designatedRequirement(output) {
  // codesign prints an implicit designated requirement as a comment.
  const match = /^(?:#\s*)?designated => (.+)$/m.exec(output);
  if (!match) throw new Error("Missing designated requirement; refusing to weaken signature verification");
  return match[1];
}

export function fixtureManifest(version, electronVersion, output, identity = "-") {
  return {
    name: "pdmux-update-probe", version, main: "main.cjs", packageManager: "bun@1.4.0",
    description: "Disposable native update compatibility probe", author: "PDMUX", license: "Apache-2.0",
    build: {
      appId: "dev.podosoft.pdmux.updateprobe", productName: "PdmuxUpdateProbe",
      electronVersion, npmRebuild: false, directories: { output }, files: ["main.cjs", "package.json"],
      artifactName: "probe-${version}-${arch}.${ext}",
      mac: { target: ["zip"], identity, hardenedRuntime: true, notarize: false },
      publish: [{ provider: "generic", url: "http://localhost/" }],
    },
  };
}

export function requireRejected(result, label) {
  assert.equal(result.error, undefined, `${label}: verification must execute`);
  assert.equal(result.signal, null, `${label}: verification must not crash`);
  assert.ok(result.status === 1 || result.status === 3, `${label}: expected signature rejection`);
  assert.match(result.stderr, /code failed to satisfy|invalid signature|sealed resource|modified|not signed/i);
  console.log(JSON.stringify({ stage: label, result: "rejected" }));
}

async function disposableSigning(root) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Disposable signing is restricted to GitHub CI");
  const directory = join(root, "signing");
  await mkdir(directory, { mode: 0o700 });
  const keychain = join(directory, "probe.keychain-db");
  const password = randomBytes(32).toString("hex");
  // Never emit command arguments: keychain operations include disposable passwords.
  const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0) throw new Error(`Disposable signing ${command}/${args[0]} failed (status ${result.status})`);
    return result.stdout;
  };
  const previous = run("security", ["list-keychains", "-d", "user"]).split("\n").map(line => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  let created = false;
  const cleanup = async () => {
    // This build-only VM is discarded by GitHub. Verification runs on a fresh VM,
    // because removing admin trust can hang on current macOS runners.
    if (created) {
      run("security", ["list-keychains", "-d", "user", "-s", ...previous]);
      run("security", ["delete-keychain", keychain]);
      created = false;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    run("security", ["create-keychain", "-p", password, keychain]);
    created = true;
    run("security", ["unlock-keychain", "-p", password, keychain]);
    run("security", ["list-keychains", "-d", "user", "-s", ...previous, keychain]);
    const identities = [];
    for (const name of ["Pdmux Probe A", "Pdmux Probe C"]) {
      const stem = join(directory, name.endsWith("A") ? "a" : "c");
      const certificate = `${stem}.crt`;
      run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${name}/O=Pdmux Update Probe`, "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=codeSigning", "-keyout", `${stem}.key`, "-out", certificate]);
      run("openssl", ["pkcs12", "-export", "-inkey", `${stem}.key`, "-in", certificate, "-out", `${stem}.p12`, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1", "-passout", "env:PDMUX_PROBE_PASSWORD"], { ...process.env, PDMUX_PROBE_PASSWORD: password });
      run("security", ["import", `${stem}.p12`, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
      // Match osx-sign's CI trust domain; user-domain trust can wait for a GUI prompt.
      run("sudo", ["-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificate]);
      identities.push(name);
    }
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    return { identities, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function fixtureSource(version) {
  return `const { app } = require('electron');
const { autoUpdater } = require(${JSON.stringify(require.resolve("electron-updater"))});
const fs = require('node:fs');
const path = require('node:path');
// LaunchServices relaunches must not depend on the invoking shell environment.
const config = JSON.parse(fs.readFileSync(path.resolve(path.dirname(process.execPath), '../../../probe-runtime.json'), 'utf8'));
const root = config.root;
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
  autoUpdater.setFeedURL({provider: 'generic', url: config.feed});
  await autoUpdater.checkForUpdates();
}).catch(error => { report('error', error.message); app.exit(1); });
`;
}

export function probeMode(args) {
  if (args.includes("--prepare-self-signed")) return "prepare";
  if (args.includes("--verify-self-signed")) return "verify";
  assert.ok(!args.includes("--self-signed"), "Self-signed verification requires a separate clean runner");
  return "adhoc";
}

export async function probe(mode = "adhoc") {
  if (process.platform !== "darwin") throw new Error("Native macOS is required; this probe cannot be validated on Linux");
  const selfSigned = mode !== "adhoc";
  const archives = process.env.PDMUX_PROBE_ARCHIVES;
  if (selfSigned) assert.ok(archives, "Missing isolated archive handoff directory");
  const root = await mkdtemp(join(tmpdir(), "pdmux-update-probe-"));
  const builder = require.resolve("electron-builder/cli.js");
  const desktop = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
  const env = probeEnvironment(process.env);
  let server;
  let child;
  let signing;
  try {
    if (mode === "prepare") signing = await disposableSigning(root);
    const versions = selfSigned ? ["0.0.1", "0.0.2", "0.0.3"] : ["0.0.1", "0.0.2"];
    for (const version of mode === "verify" ? [] : versions) {
      const source = join(root, version);
      await mkdir(source);
      const identity = signing?.identities[version === "0.0.3" ? 1 : 0] ?? "-";
      await writeFile(join(source, "package.json"), JSON.stringify(fixtureManifest(version, desktop.devDependencies.electron, join(root, `out-${version}`), identity)));
      await writeFile(join(source, "main.cjs"), fixtureSource(version));
      execFileSync(process.execPath, [builder, "--projectDir", source, "--mac", `--${process.arch}`, "--publish", "never"], { env, stdio: "inherit", timeout: 300_000 });
      if (mode === "prepare") {
        const output = join(root, `out-${version}`);
        const destination = join(archives, `out-${version}`);
        await mkdir(destination, { recursive: true });
        for (const file of (await readdir(output)).filter(name => /\.(zip|yml|blockmap)$/.test(name))) {
          await copyFile(join(output, file), join(destination, file));
        }
      }
    }
    if (signing) {
      await signing.cleanup();
      signing = undefined;
      console.log(JSON.stringify({ stage: "remove-private-signing-material", result: "complete" }));
    }
    if (mode === "prepare") return;
    const outputRoot = mode === "verify" ? archives : root;
    const apps = [];
    for (const version of versions) {
      const output = join(outputRoot, `out-${version}`);
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
    console.log(signature.stdout + signature.stderr);
    const requirement = designatedRequirement(signature.stdout + signature.stderr);
    console.log(JSON.stringify({ stage: "old-app-requirement", requirement }));
    execFileSync("codesign", ["--verify", "--deep", "--strict", "-R", `=${requirement}`, apps[1]], { stdio: "inherit" });
    console.log(JSON.stringify({ stage: "same-key-update", result: "accepted" }));
    if (selfSigned) {
      const args = ["--verify", "--deep", "--strict", "-R", `=${requirement}`];
      requireRejected(spawnSync("codesign", [...args, apps[2]], { encoding: "utf8", timeout: 30_000 }), "different-key-update");
      const tampered = join(root, "tampered.app");
      execFileSync("ditto", [apps[1], tampered]);
      await writeFile(join(tampered, "Contents/Resources/app.asar"), "tampered fixture");
      requireRejected(spawnSync("codesign", [...args, tampered], { encoding: "utf8", timeout: 30_000 }), "tampered-update");
    }

    const feedRoot = join(outputRoot, "out-0.0.2");
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
    await writeFile(join(dirname(apps[0]), "probe-runtime.json"), JSON.stringify({ root, feed: `http://127.0.0.1:${address.port}` }), { mode: 0o600 });
    child = spawn(join(apps[0], "Contents/MacOS/PdmuxUpdateProbe"), [], {
      env, stdio: "inherit",
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
    if (signing) await signing.cleanup();
    if (child) {
      console.log(await readFile(join(root, "events.jsonl"), "utf8").catch(() => "No fixture events"));
      const installed = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(root, "extracted-0.0.1/PdmuxUpdateProbe.app/Contents/Info.plist")], { encoding: "utf8", timeout: 10_000 });
      console.log(JSON.stringify({ stage: "installed-version", version: installed.stdout?.trim(), status: installed.status }));
      const shipIt = join(homedir(), "Library/Caches/dev.podosoft.pdmux.updateprobe.ShipIt/ShipIt_stderr.log");
      console.log(await readFile(shipIt, "utf8").catch(() => "No fixture ShipIt log"));
    }
    child?.kill("SIGTERM");
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    // A relaunched updater child may still use these files. The disposable CI VM owns cleanup.
    if (!child) await rm(root, { recursive: true, force: true });
    else console.error(`Retained isolated update fixture: ${root}`);
  }
}

if (import.meta.main) await probe(probeMode(process.argv));
