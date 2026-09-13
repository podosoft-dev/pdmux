import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { desktopPaths } from "./desktop-package-paths.mjs";

// Exercise the real Chromium downloader and process restart with a throttled,
// authenticated HTTPS fixture. Application API/ZIP semantics have their own
// readiness suite; no DownloadItem, Session, IPC or filesystem implementation is mocked.
assert.equal(process.platform, "linux", "Use an isolated Linux display and configuration directory");
const bundle = resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), "pdmux-native-download-"));
const configuration = join(temporary, "configuration");
const userData = join(configuration, "pdmux-desktop");
const destination = join(temporary, "download.zip");
const hostId = randomUUID();
const transferId = randomUUID();
const route = `/api/hosts/${hostId}/file-transfers/${transferId}`;
const payload = randomBytes(8 * 1024 * 1024);
const etag = `"${createHash("sha256").update(payload).digest("hex")}"`;
const token = randomUUID();
const downloads = [];
let allowed = true;
let application;
let server;

async function quit() {
  const closed = application.waitForEvent("close", { timeout: 15_000 });
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await closed;
  application = undefined;
}

async function eventually(check, message) {
  const deadline = Date.now() + 30_000;
  do {
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

try {
  await mkdir(userData, { recursive: true });
  const keyPath = join(temporary, "fixture.key");
  const certificatePath = join(temporary, "fixture.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certificatePath], { stdio: "ignore", timeout: 30_000 });
  const certificate = await readFile(certificatePath);
  server = createServer({ key: await readFile(keyPath), cert: certificate }, (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body><p>Native download verification</p></body></html>");
      return;
    }
    if (!allowed || request.headers.cookie !== `readiness=${token}`) { response.writeHead(403).end(); return; }
    if (request.url === route) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: "ready", etag, archiveBytes: payload.length }));
      return;
    }
    if (request.url !== `${route}/download`) { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const offset = range ? Number(range[1]) : 0;
    downloads.push({ offset, ifRange: request.headers["if-range"] });
    response.writeHead(offset ? 206 : 200, {
      "content-type": "application/zip", "content-length": payload.length - offset,
      "content-disposition": 'attachment; filename="download.zip"', "accept-ranges": "bytes", etag,
      ...(offset ? { "content-range": `bytes ${offset}-${payload.length - 1}/${payload.length}` } : {}),
    });
    let sent = offset;
    const timer = setInterval(() => {
      const end = Math.min(sent + 65_536, payload.length);
      response.write(payload.subarray(sent, end));
      sent = end;
      if (sent === payload.length) { clearInterval(timer); response.end(); }
    }, 25);
    response.once("close", () => clearInterval(timer));
  });
  await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  const origin = `https://127.0.0.1:${server.address().port}`;
  await writeFile(join(userData, "desktop.json"), JSON.stringify({ mode: "remote", url: origin,
    certificatePins: [new X509Certificate(certificate).fingerprint256.replaceAll(":", "")], closeToTray: false }));
  async function launch() {
    console.log(JSON.stringify({ stage: "native-download-launch" }));
    application = await electron.launch({ executablePath: desktopPaths(bundle, "linux").executable, chromiumSandbox: true,
      env: { ...process.env, XDG_CONFIG_HOME: configuration }, timeout: 60_000 });
    application.process().stderr.on("data", chunk => process.stderr.write(chunk));
    const window = await application.firstWindow();
    await window.waitForURL(`${origin}/`);
    await window.getByText("Native download verification").waitFor();
    return window;
  }
  let window = await launch();
  await application.evaluate(async ({ session, dialog }, values) => {
    await session.defaultSession.cookies.set({ url: values.origin, name: "readiness", value: values.token,
      expirationDate: Date.now() / 1000 + 3600, secure: true, httpOnly: true });
    await session.defaultSession.cookies.flushStore();
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: values.destination });
  }, { origin, token, destination });
  const start = page => page.evaluate(({ hostId, transferId }) => window.pdmuxDesktop.transfers.download(hostId, transferId), { hostId, transferId });
  const status = page => page.evaluate(id => window.pdmuxDesktop.transfers.status(id), transferId);
  await start(window);
  console.log(JSON.stringify({ stage: "native-download-started" }));
  await eventually(async () => (await status(window))?.received >= 262_144, "Receive partial native download");
  await window.evaluate(id => window.pdmuxDesktop.transfers.pauseDownload(id), transferId);
  await quit();
  console.log(JSON.stringify({ stage: "native-download-stopped" }));
  const records = JSON.parse(await readFile(join(userData, "file-transfers/downloads.json"), "utf8"));
  const record = records.find(row => row.id === transferId);
  assert.equal(record.state, "interrupted");
  assert.ok(record.received > 0 && record.received < payload.length);
  const partial = `${destination}.pdmux-download-${transferId}.part`;
  assert.ok((await stat(`${partial}.resume`)).size >= record.received, "Preserve partial file after process exit");
  await assert.rejects(stat(destination), { code: "ENOENT" });
  window = await launch();
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => { throw new Error("Resuming must preserve the selected destination"); };
  });
  allowed = false;
  const beforeDenied = downloads.length;
  await assert.rejects(start(window), /FILES_TRANSFER_FORBIDDEN/);
  assert.equal(downloads.length, beforeDenied, "Recheck authorization before reusing partial bytes");
  allowed = true;
  await start(window);
  await eventually(async () => (await status(window))?.state === "completed", "Complete native download after process restart");
  assert.equal(`"${createHash("sha256").update(await readFile(destination)).digest("hex")}"`, etag);
  await assert.rejects(stat(partial), { code: "ENOENT" });
  await assert.rejects(stat(`${partial}.resume`), { code: "ENOENT" });
  assert.equal(downloads.length, 2, "Request only the initial body and its missing suffix");
  assert.equal(downloads[1].offset, record.received);
  assert.equal(downloads[1].ifRange, etag);
  console.log(JSON.stringify({ stage: "native-download-restart", result: "passed", bytes: payload.length,
    resumedOffset: record.received, authorized: true, sha256: etag.slice(1, -1) }));
} finally {
  if (application) await quit();
  if (server) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
  await rm(temporary, { recursive: true, force: true });
}
