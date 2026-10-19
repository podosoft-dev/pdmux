import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { fixtureNativeEngines, fixtureNativeSessions, stopFixtureNativeSessions } from "./native-session-fixture.mjs";

// [TC-PDDESKTOP-025] [TC-PDDESKTOP-026] [TC-PDDESKTOP-027] Real Electron, preload, local persistence, settings navigation,
// and terminal rendering. Only the disposable profile's sessions may be terminated.
const directory = resolve(process.env.PDMUX_PREFERENCES_EVIDENCE ?? "output/playwright/toolbar/preferences");
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "pdmux-preferences-ui-"));
const profile = join(root, "profile");
let application;
const executablePath = process.env.PDMUX_ELECTRON_EXECUTABLE;
const options = {
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : [resolve("apps/desktop")]), `--user-data-dir=${profile}`, "--use-mock-keychain"],
  env: { ...process.env, PDMUX_DESKTOP_AGENT_RELEASE_DIR: resolve("apps/web/static/agent"), TMUX: "" },
  timeout: 60_000,
};
async function launch() {
  application = await _electron.launch(options);
  assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), profile);
  const page = await application.firstWindow();
  await page.locator('html[data-hydrated="true"]').waitFor({ timeout: 60_000 });
  await page.waitForFunction(async () => (await window.pdmuxDesktop.localAgent.status()).phase === "ready", undefined, { timeout: 45_000 });
  await page.locator(".xterm-rows").first().waitFor({ timeout: 30_000 });
  return page;
}
try {
  let page = await launch();
  const { verifySettingsDialog } = await import("./settings-dialog-ui.mjs");
  const engines = await fixtureNativeEngines(profile);
  const original = engines.flatMap(fixtureNativeSessions);
  const result = await verifySettingsDialog(page, directory, { desktop: true });
  for (const session of original) assert.equal(engines.flatMap(fixtureNativeSessions).find(row => row.id === session.id)?.pid, session.pid, "[TC-PDDESKTOP-025] modal settings preserves native shell PIDs");
  await page.getByTestId("shell-user").click();
  await page.getByTestId("shell-user-settings").click();
  await page.getByTestId("settings-tab-terminal").click();
  await page.getByTestId("terminal-font-size").fill("18");
  await page.getByTestId("settings-ok").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(() => window.pdmuxDesktop.preferences.read())).fontSize, 18);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".xterm-rows")).fontSize === "18px");
  assert.equal(JSON.parse(await readFile(join(profile, "terminal-preferences.json"), "utf8")).fontSize, 18);
  await application.close(); application = undefined;
  page = await launch();
  assert.equal((await page.evaluate(() => window.pdmuxDesktop.preferences.read())).fontSize, 18);
  for (const session of original) assert.equal(engines.flatMap(fixtureNativeSessions).find(row => row.id === session.id)?.pid, session.pid);
  const probeWindow = application.waitForEvent("window");
  await application.evaluate(async ({ BrowserWindow, app }) => { const probe = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + "/dist/preload.cjs", sandbox: true, contextIsolation: true, additionalArguments: ["--pdmux-local-runtime=1"] } }); await probe.loadURL("data:text/html,<title>Untrusted settings probe</title>"); });
  const probe = await probeWindow;
  for (const operation of ["preferences", "connect", "open"]) assert.ok(await probe.evaluate(async operation => {
    try {
      if (operation === "preferences") await window.pdmuxDesktop.preferences.read();
      if (operation === "connect") await window.pdmuxDesktop.connection.connect();
      if (operation === "open") await window.pdmuxDesktop.connection.open("account");
      return false;
    } catch { return true; }
  }, operation), "[TC-PDDESKTOP-027] untrusted windows cannot invoke account IPC");
  await probe.close();
  // Capture the OS handoff, keeping PKCE material out of logs and artifacts.
  await application.evaluate(({ shell }) => {
    const originalFetch = globalThis.fetch;
    globalThis.__openedLogin = null;
    shell.openExternal = async value => { const url = new URL(value); globalThis.__openedLogin = { origin: url.origin, path: url.pathname, pkce: url.searchParams.has("code_challenge") }; };
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/desktop/capabilities" && url.protocol === "https:") return Response.json({ version: 1, local: false });
      return originalFetch(input, init);
    };
  });
  await page.getByTestId("shell-user").click();
  assert.equal(await page.getByTestId("shell-user-identity").count(), 0);
  assert.equal(await page.getByTestId("shell-user-admin").count(), 0);
  await page.getByTestId("shell-user-signin").click();
  await page.getByTestId("desktop-login-dialog").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-login-dialog"] button').disabled);
  for (let attempt = 0; attempt < 100 && !await application.evaluate(() => globalThis.__openedLogin); attempt++) await page.waitForTimeout(100);
  const opened = await application.evaluate(() => globalThis.__openedLogin);
  assert.equal(opened?.path, "/desktop/connect", "[TC-PDDESKTOP-027] use the existing browser login flow");
  assert.equal(opened?.origin, (await import("../apps/desktop/src/config.ts")).DEFAULT_DESKTOP_CONFIG.serverUrl);
  await page.screenshot({ path: join(directory, "browser-login.png"), scale: "css" });
  await page.getByTestId("desktop-login-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  for (const target of ["account", "https://untrusted.example.test"]) assert.ok(await page.evaluate(async target => { try { await window.pdmuxDesktop.connection.open(target); return false; } catch { return true; } }, target), "[TC-PDDESKTOP-027] signed-out or unsupported external destinations are rejected");
  // Renderer identity fixture exercises menus without signing into the user's account.
  let cloudUser = { id: "profile-test", name: "Server Member", email: "member@example.test", role: "user" };
  await page.route("**/api/desktop/status", async route => route.fulfill({ json: { local: true, connected: Boolean(cloudUser), bridgeConnected: true, user: cloudUser, serverUrl: "https://server.example.test", scopeId: "personal:profile-test" } }));
  await page.waitForTimeout(3_200);
  await page.getByTestId("shell-user").click();
  await page.getByTestId("shell-user-identity").waitFor();
  assert.ok((await page.getByTestId("shell-user-identity").innerText()).includes("member@example.test"));
  assert.equal(await page.getByTestId("shell-user-admin").count(), 0);
  assert.deepEqual(await page.getByTestId("shell-user-menu").getByRole("menuitem").allTextContents(), ["Settings", "Account", "Sign out"]);
  await page.screenshot({ path: join(directory, "member-menu.png"), scale: "css" });
  await page.keyboard.press("Escape"); cloudUser = { ...cloudUser, name: "Server Admin", role: "admin" };
  await page.waitForTimeout(3_200); await page.getByTestId("shell-user").click();
  assert.equal(await page.getByTestId("shell-user-admin").count(), 1);
  await page.screenshot({ path: join(directory, "admin-menu.png"), scale: "css" });
  await page.keyboard.press("Escape"); cloudUser = null;
  await page.waitForTimeout(3_200); await page.getByTestId("shell-user").click();
  assert.equal(await page.getByTestId("shell-user-identity").count(), 0);
  assert.equal(await page.getByTestId("shell-user-account").count(), 0);
  assert.equal(await page.getByTestId("shell-user-signin").count(), 1);
  await writeFile(join(directory, "result.json"), JSON.stringify({ ...result, nativeSessionsPreserved: true, persistenceAcrossLaunches: true, accountMenusVerifiedWithRendererFixture: true, untrustedWindowRejected: true, defaultBrowserHandoffVerifiedWithOsStub: true }, null, 2));
  console.log(JSON.stringify({ result: "passed", checks: ["settings-dialog", "native-session-preservation", "persistence", "profile-menus", "default-browser-handoff", "IPC-origin-guard"] }));
} finally {
  await application?.close().catch(() => {});
  await stopFixtureNativeSessions(profile).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
