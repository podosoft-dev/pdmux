// [TC-PDTERM-022] Real web and Electron clients sharing one persistent terminal.
// Invoked by the isolated synchronization fixture; never connects to a user's host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, _electron as electron } from "playwright";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, cookie, workspaceId, profile, tmux, serverTmuxSocket, output } = JSON.parse(input);
await mkdir(output, { recursive: true }); await mkdir(tmux, { recursive: true });
const session = "shared-size";
function mux(...args) {
  return execFileSync("tmux", ["-S", serverTmuxSocket, ...args], { env: { ...process.env, TMUX: "" }, encoding: "utf8" }).trim();
}
function facts() {
  const [cols, rows, pid, clients] = mux("display-message", "-p", "-t", `=${session}:`, "#{window_width}|#{window_height}|#{pane_pid}|#{session_attached}").split("|").map(Number);
  return { cols, rows, pid, clients };
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Shared terminal condition failed: ${label}`);
}
async function api(page, path, method = "GET", body) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Fixture API ${response.status}`); return response.json();
  }, { path, method, body });
}
function watch(page) {
  const state = { page, id: null, cols: 0, rows: 0 };
  page.on("websocket", socket => {
    if (!new URL(socket.url()).pathname.endsWith("/terminal/ws")) return;
    socket.on("framesent", frame => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "open" && value.target.session === session) { state.id = value.termId; Object.assign(state, { cols: value.target.cols, rows: value.target.rows }); }
      if (value.type === "resize" && value.termId === state.id) Object.assign(state, { cols: value.cols, rows: value.rows });
    });
  });
  return state;
}
async function send(page, command) {
  await page.locator("[data-pdmux-surface]").click();
  await page.keyboard.type(command); await page.keyboard.press("Enter");
}
async function shows(page, marker) { return (await page.locator("[data-pdmux-surface]").innerText()).includes(marker); }
async function geometry(state) {
  return state.page.locator("[data-pdmux-surface]").evaluate((element, size) => ({ ...size, box: element.getBoundingClientRect().toJSON(), dpr: devicePixelRatio, text: element.innerText }), { cols: state.cols, rows: state.rows });
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
await context.addCookies(cookie.split("; ").map(value => { const separator = value.indexOf("="); return { name: value.slice(0, separator), value: value.slice(separator + 1), url }; }));
const application = await electron.launch({ args: [resolve(import.meta.dirname, "../apps/desktop"), `--user-data-dir=${profile}`], env: { ...process.env, TMUX: "", TMUX_TMPDIR: tmux }, chromiumSandbox: true, timeout: 60_000 });
let web;
let desktop;
const measurements = [];
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
  if (!workspaceId.startsWith("personal:")) await desktop.evaluate(async id => window.pdmuxDesktop.connection.workspace(id), workspaceId);
  const serverHosts = await (await context.request.get(`${url}/api/hosts`)).json();
  const remote = serverHosts.find(host => host.label === "server-owned"); assert.ok(remote);
  const localHosts = await until(() => api(desktop, "/api/hosts"), hosts => hosts.some(host => host.label === remote.label), "mirrored server host");
  const mirrored = localHosts.find(host => host.label === remote.label);
  web = await context.newPage(); let large = watch(web);
  await web.goto(`${url}/terminal?host=${remote.id}&kind=new&session=${session}`);
  await web.locator("[data-pdmux-surface] .xterm-rows").waitFor();
  await until(() => facts(), value => value.clients === 1 && large.cols > 0, "large browser attachment");
  await send(web, "PDMUX_SHARED_TEST=SCREEN_OK; printf 'SHARED_%s\\n' \"$PDMUX_SHARED_TEST\"");
  await until(() => shows(web, "SHARED_SCREEN_OK"), Boolean, "real shell output");
  const pid = facts().pid;
  const compact = watch(desktop);
  await api(desktop, "/api/prefs/layouts/default", "PUT", { payload: { mode: "split4", slots: [{ id: "shared-slot", hostId: mirrored.id, kind: "attach", session }], focusId: "shared-slot", sidebarOpen: true, dockOpen: false, filesOpen: false }, isDefault: true });
  await desktop.reload();
  await until(() => facts(), value => value.clients === 2 && compact.cols > 0, "desktop four-pane attachment");
  async function snapshot(stage) {
    const current = facts();
    const browserGeometry = web.isClosed() ? null : await geometry(large);
    const desktopGeometry = await geometry(compact);
    for (const measured of [browserGeometry, desktopGeometry]) if (measured) assert.ok(measured.box.width > 200 && measured.box.height > 100);
    measurements.push({ stage, window: current, browser: browserGeometry, desktop: desktopGeometry });
    if (!web.isClosed()) await web.screenshot({ path: join(output, `browser-${stage}.png`) });
    await desktop.screenshot({ path: join(output, `desktop-${stage}.png`) });
    await writeFile(join(output, "geometry.json"), JSON.stringify(measurements, null, 2));
    return current;
  }
  // Capture the original regression before asserting, so a failing baseline has evidence.
  await send(web, "printf 'BOTH_%s\\n' \"$PDMUX_SHARED_TEST\"");
  await until(() => shows(desktop, "BOTH_SCREEN_OK"), Boolean, "the same live shell in both clients");
  const initial = await snapshot("shared");
  assert.equal(initial.cols, Math.max(large.cols, compact.cols), "[TC-PDTERM-022] a compact viewer must not shrink the large browser");
  assert.equal(initial.rows, Math.max(large.rows, compact.rows));
  const previous = compact.cols;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith("http:")).setSize(1000, 700));
  await until(() => compact.cols, value => value > 0 && value < previous, "actual compact desktop resize");
  await until(() => facts(), value => value.cols === large.cols && value.rows === large.rows, "large browser geometry retained");
  await snapshot("smaller-desktop");
  await web.close();
  await until(() => facts(), value => value.clients === 1 && value.cols === compact.cols && value.rows === compact.rows, "remaining desktop owns the size");
  await snapshot("browser-closed");
  web = await context.newPage(); large = watch(web);
  await web.goto(`${url}/terminal?host=${remote.id}&kind=attach&session=${session}`);
  await until(() => facts(), value => value.clients === 2 && large.cols > 0 && value.cols === large.cols, "large browser reattached");
  await send(web, "printf 'REATTACHED_%s\\n' \"$PDMUX_SHARED_TEST\"");
  await until(() => shows(web, "REATTACHED_SCREEN_OK"), Boolean, "original shell environment after reconnect");
  assert.equal(facts().pid, pid, "Keep the original application process");
  await snapshot("reattached");
  await writeFile(join(output, "result.json"), JSON.stringify({ result: "passed", policy: "largest", browser: "Chromium headed", desktop: "Electron headed", sameShellPid: true, measurements }, null, 2));
  console.log(JSON.stringify({ stage: "shared-terminal-size", result: "passed", clients: ["browser-single", "desktop-split4"], sameShellPid: true }));
} finally {
  await application.close(); await browser.close(); process.disconnect?.();
}
