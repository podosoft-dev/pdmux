import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, _electron as electron } from "playwright";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, cookie, workspaceId, profile, tmux, output } = JSON.parse(input);
await mkdir(output, { recursive: true }); await mkdir(tmux, { recursive: true });
let nextId = 0;
const pending = new Map();
process.on("message", message => { const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer); message.ok ? waiter.accept(message.facts) : waiter.reject(new Error("Recovery fixture action failed")); });
async function control(action) {
  const id = ++nextId;
  return new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(`Recovery fixture timed out: ${action}`)), 45_000); pending.set(id, { accept, reject, timer }); process.send({ id, action }); });
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 25_000;
  let last;
  while (Date.now() < deadline) { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Recovery condition failed: ${label}`);
}
async function api(page, path) { return page.evaluate(async path => { const response = await fetch(path); if (!response.ok) throw new Error(`API ${response.status}`); return response.json(); }, path); }
async function shows(page, marker) { return (await page.locator("[data-pdmux-surface]").innerText()).replace(/\s+/g, "").includes(marker); }
async function send(page, command) { await page.locator("[data-pdmux-surface]").click(); await page.keyboard.type(command); await page.keyboard.press("Enter"); }
async function measure(page) { return page.locator("[data-pdmux-surface]").evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }; }); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
await context.addCookies(cookie.split("; ").map(value => { const separator = value.indexOf("="); return { name: value.slice(0, separator), value: value.slice(separator + 1), url }; }));
const application = await electron.launch({ args: [resolve(import.meta.dirname, "../apps/desktop"), `--user-data-dir=${profile}`], env: { ...process.env, TMUX: "", TMUX_TMPDIR: tmux }, chromiumSandbox: true, timeout: 60_000 });
const web = await context.newPage();
let desktop;
let pages = [];
try {
  await application.evaluate(({ shell }) => { shell.openExternal = async value => { globalThis.__pdmuxAuthUrl = value; }; });
  desktop = await application.firstWindow({ timeout: 60_000 });
  await desktop.locator('[data-testid="shell-user"]').waitFor({ timeout: 45_000 });
  await desktop.evaluate(async url => window.pdmuxDesktop.connection.connect(url), url);
  const loginUrl = await application.evaluate(() => globalThis.__pdmuxAuthUrl);
  const transfer = await fetch(`${url}/api/auth/electron/transfer-user${new URL(loginUrl).search}`, { method: "POST", headers: { cookie, origin: url, "content-type": "application/json" }, body: "{}" });
  assert.equal(transfer.status, 200);
  const authorization = transfer.headers.getSetCookie().find(value => value.startsWith("better-auth.pdmux-desktop="));
  assert.ok(authorization);
  await desktop.evaluate(async code => window.pdmuxDesktop.connection.authenticate(code), authorization.split(";")[0].slice("better-auth.pdmux-desktop=".length));
  await desktop.evaluate(async id => window.pdmuxDesktop.connection.workspace(id), workspaceId);
  const cloudHost = (await (await context.request.get(`${url}/api/hosts`)).json()).find(host => host.label === "server-owned");
  assert.ok(cloudHost);
  const localHost = await until(() => api(desktop, "/api/hosts"), hosts => hosts.some(host => host.label === "server-owned"), "desktop host sync");
  const mirrored = localHost.find(host => host.label === "server-owned");
  pages = [{ page: web, name: "browser", origin: url, host: cloudHost.id }, { page: desktop, name: "desktop", origin: new URL(desktop.url()).origin, host: mirrored.id }];
  const evidence = [];
  for (const entry of pages) {
    entry.ready = 0;
    entry.inputs = [];
    entry.page.on("websocket", socket => {
      if (!new URL(socket.url()).pathname.endsWith("/terminal/ws")) return;
      socket.on("framereceived", frame => { try { if (JSON.parse(String(frame.payload)).type === "ready") entry.ready += 1; } catch { /* Other frames do not confirm attachment. */ } });
      socket.on("framesent", frame => { try { const value = JSON.parse(String(frame.payload)); if (value.type === "input") entry.inputs.push(value.data); } catch { /* Ignore non-terminal traffic. */ } });
    });
    await entry.page.goto(`${entry.origin}/terminal?host=${entry.host}&kind=new&session=recovery-${entry.name}`);
    await entry.page.locator("[data-pdmux-surface] .xterm-rows").waitFor({ timeout: 20_000 });
    await until(() => entry.page.locator("[data-pdmux-surface]").innerText(), text => text.trim().length > 0, `${entry.name} prompt`);
    entry.marker = `RECOVERED_${entry.name.toUpperCase()}_${Date.now()}`;
    await send(entry.page, `export PDMUX_RECOVERY=${entry.marker}`);
    await send(entry.page, "printf '%s\\n' \"$PDMUX_RECOVERY\"");
    await until(() => shows(entry.page, entry.marker), Boolean, `${entry.name} initial echo`);
    entry.initialReady = entry.ready;
    // A newly generated document marker detects a hidden full-page reload.
    entry.document = await entry.page.evaluate(() => { window.__pdmuxRecoveryDocument = crypto.randomUUID(); return window.__pdmuxRecoveryDocument; });
    evidence.push({ name: entry.name, before: await measure(entry.page) });
    await entry.page.screenshot({ path: join(output, `${entry.name}-before.png`) });
    await send(entry.page, "printf 'BEFORE_%s\\n' \"$PDMUX_RECOVERY\"");
    await until(() => shows(entry.page, `BEFORE_${entry.marker}`), Boolean, `${entry.name} baseline input before outage`);
  }
  await control("outage");
  await new Promise(resolve => setTimeout(resolve, 6_000));
  const offline = await api(desktop, "/api/desktop/status");
  assert.equal(offline.connected, true, "[TC-PDDESKTOP-012] a temporary 503 must not sign out the desktop");
  assert.ok(["DESKTOP_SERVER_UNAVAILABLE", "DESKTOP_BRIDGE_UNAVAILABLE", "DESKTOP_SYNC_FAILED"].includes(offline.error), "Report the interrupted sync or bridge while preserving the session");
  await control("restore");
  // The API is healthy first. Clients must retain their panes during offline-host
  // rejections, instead of receiving an error frame that permanently releases them.
  await new Promise(resolve => setTimeout(resolve, 2_000));
  await control("agent-online");
  const restoredFacts = await control("facts");
  for (const [index, entry] of pages.entries()) {
    await until(() => Promise.resolve(entry.ready), count => count > entry.initialReady, `${entry.name} new terminal attachment`);
    assert.equal(await entry.page.evaluate(() => window.__pdmuxRecoveryDocument), entry.document, "No full-page reload");
    const restored = `AFTER_${entry.marker}`;
    // The command does not contain the expanded marker: only a live session that
    // retained the environment variable can print it after the server restarts.
    await send(entry.page, "printf 'AFTER_%s\\n' \"$PDMUX_RECOVERY\"");
    await until(() => shows(entry.page, restored), Boolean, `${entry.name} recovered input and session`);
    const after = await measure(entry.page);
    assert.ok(after.width > 200 && after.height > 100);
    evidence[index].after = after;
    await entry.page.screenshot({ path: join(output, `${entry.name}-after.png`) });
  }
  await until(() => api(desktop, "/api/desktop/status"), status => status.connected && status.bridgeConnected && status.error === null, "desktop bridge and sync recovery");
  await writeFile(join(output, "geometry.json"), JSON.stringify({ browser: "Playwright Chromium headless", desktop: "Electron 44 macOS", offlineError: offline.error, restoredFacts, evidence }, null, 2));
  console.log(JSON.stringify({ stage: "terminal-server-recovery", result: "passed", clients: ["browser", "desktop"], pageReloads: 0, sessionsPreserved: true }));
} finally {
  await writeFile(join(output, "input-diagnostic.json"), JSON.stringify({ facts: await control("facts").catch(() => "unavailable"), clients: pages.map(({ name, inputs, ready }) => ({ name, inputs, ready })) }, null, 2));
  for (const [name, page] of [["browser", web], ["desktop", desktop]]) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `${name}-last.png`) }).catch(() => undefined);
  await application.close(); await browser.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  process.disconnect?.();
}
