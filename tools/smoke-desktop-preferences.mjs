import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { fixtureNativeEngines, fixtureNativeSessions, stopFixtureNativeSessions } from "./native-session-fixture.mjs";

// [TC-PDDESKTOP-025] Real Electron, preload, local persistence, settings navigation,
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
  await page.locator('[data-testid="shell-user"]').click();
  const menu = page.locator('[data-testid="shell-user-menu"]');
  await menu.waitFor();
  const before = await menu.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight, items: [...node.querySelectorAll('[role="menuitem"]')].map(item => item.textContent.trim()) }));
  await page.screenshot({ path: join(directory, "menu.png"), scale: "css" });
  if (process.argv.includes("--baseline")) {
    const hasSettings = await menu.locator('[data-testid="desktop-menu-settings"]').count();
    await writeFile(join(directory, "baseline.json"), JSON.stringify({ ...before, hasSettings, newNavigationPasses: hasSettings === 1 }, null, 2));
    assert.equal(hasSettings, 0, "Baseline must fail the new Settings entry requirement");
    console.log(JSON.stringify({ result: "baseline-rejected", ...before }));
  } else {
    assert.equal(await menu.getByRole("menuitem").count(), 2);
    for (const id of ["desktop-menu-backup", "desktop-menu-data", "nav-hosts", "nav-settings", "nav-access", "shell-server-connection"]) assert.equal(await menu.locator(`[data-testid="${id}"]`).count(), 0);
    const engines = await fixtureNativeEngines(profile);
    const original = engines.flatMap(fixtureNativeSessions);
    await page.locator('[data-testid="desktop-menu-settings"]').click();
    await page.waitForURL(url => url.pathname === "/preferences" && url.searchParams.get("tab") === "general");
    await page.locator('[data-testid="desktop-general-settings"]').waitFor();
    await page.locator('[data-testid="settings-tab-terminal"]').click();
    await page.waitForURL(url => url.pathname === "/preferences" && !url.searchParams.has("tab"));
    const frame = page.locator('[data-testid="desktop-settings"]');
    const measure = async () => {
      const nav = await frame.getByRole("tablist").first().boundingBox();
      const body = await frame.getByRole("tabpanel").first().boundingBox();
      assert.ok(nav && body && nav.x + nav.width <= body.x && body.width > 300 && body.height > 200, "[TC-PDDESKTOP-025] tabs are left of usable content");
      const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(overflow.width <= overflow.viewport + 1);
      assert.equal(await frame.getByRole("heading", { level: 1 }).count(), 1);
      return { nav, body, overflow };
    };
    await page.locator('[data-testid="terminal-settings-save"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="terminal-settings-save"]').disabled);
    const geometry = await measure();
    await page.locator('[data-testid="terminal-font"]').click();await page.getByRole("option", { name: "Menlo", exact: true }).click();
    await page.locator('[data-testid="terminal-font-size"]').fill("18");
    await page.locator('[data-testid="terminal-line-height"]').fill("1.3");
    await page.locator('[data-testid="terminal-theme"]').click();await page.getByRole("option", { name: "Light", exact: true }).click();
    await page.locator('[data-testid="terminal-cursor"]').click();await page.getByRole("option", { name: "Bar", exact: true }).click();
    await page.locator('[data-testid="terminal-cursor-blink"]').uncheck();
    await page.locator('[data-testid="terminal-settings-save"]').click();
    await page.getByRole("status").filter({ hasText: "Saved and applied" }).waitFor();
    const wanted = { fontFamily: "Menlo", fontSize: 18, lineHeight: 1.3, theme: "light", cursorStyle: "bar", cursorBlink: false };
    assert.deepEqual(await page.evaluate(() => window.pdmuxDesktop.preferences.read()), wanted);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "terminal-preferences.json"), "utf8")), wanted);
    const rejected = await page.evaluate(async () => { try { await window.pdmuxDesktop.preferences.save({ fontFamily: "Menlo", fontSize: 100, lineHeight: 1, theme: "light", cursorStyle: "bar", cursorBlink: true }); return false; } catch { return true; } });
    assert.ok(rejected, "[TC-PDDESKTOP-025] IPC rejects invalid settings");
    assert.deepEqual(await page.evaluate(() => window.pdmuxDesktop.preferences.read()), wanted);
    await page.screenshot({ path: join(directory, "terminal-settings.png"), scale: "css" });
    const probeWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow, app }) => { const probe = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + "/dist/preload.cjs", sandbox: true, contextIsolation: true, additionalArguments: ["--pdmux-local-runtime=1"] } }); await probe.loadURL("data:text/html,<title>Untrusted settings probe</title>"); });
    const probe = await probeWindow;
    assert.ok(await probe.evaluate(() => typeof window.pdmuxDesktop?.preferences?.read === "function"), "The untrusted-window probe must have the real preload bridge");
    assert.ok(await probe.evaluate(async () => { try { await window.pdmuxDesktop.preferences.read(); return false; } catch { return true; } }), "[TC-PDDESKTOP-025] untrusted window cannot read device preferences");
    assert.ok(await probe.evaluate(async () => { try { await window.pdmuxDesktop.preferences.save({ fontFamily: "monospace", fontSize: 13, lineHeight: 1, theme: "pdmux", cursorStyle: "block", cursorBlink: true }); return false; } catch { return true; } }), "[TC-PDDESKTOP-025] untrusted window cannot change device preferences");
    assert.deepEqual(await page.evaluate(() => window.pdmuxDesktop.preferences.read()), wanted);
    await probe.close();
    const routes = [];
    for (const tab of ["general", "hosts", "fleet", "access", "connection", "advanced", "terminal"]) {
      await page.locator(`[data-testid="settings-tab-${tab}"]`).click();
      const targets = { general: ["/preferences", "desktop-general-settings"], hosts: ["/hosts", "hosts-panel"], fleet: ["/settings", "fleet-settings-panel"], access: ["/access", "mcp-tokens"], connection: ["/connection", "desktop-connection"], advanced: ["/preferences", "desktop-settings-data"], terminal: ["/preferences", "terminal-settings-form"] };
      await page.waitForURL(url => url.pathname === targets[tab][0] && (["advanced", "general"].includes(tab) ? url.searchParams.get("tab") === tab : !url.searchParams.has("tab")));
      await page.locator(`[data-testid="${targets[tab][1]}"]`).waitFor();
      await page.locator(`[data-testid="settings-content-${tab}"]`).waitFor();
      routes.push({ tab, ...await measure() });
      if (tab === "advanced") assert.equal(await page.locator('[data-testid="desktop-settings-data"]').count(), 1);
      else assert.equal(await page.locator('[data-testid="desktop-settings-data"]').count(), 0);
      await page.screenshot({ path: join(directory, `${tab}.png`), scale: "css" });
    }
    await page.setViewportSize({ width: 900, height: 700 });await measure();
    await page.screenshot({ path: join(directory, "settings-900.png"), scale: "css" });
    await page.setViewportSize({ width: 1440, height: 928 });
    await frame.locator('[data-testid="open-dashboard"]').click();await page.waitForURL(url => url.pathname === "/");
    await page.locator(".xterm-rows").first().waitFor();
    const rendered = await page.locator(".xterm-rows").first().evaluate(node => ({ fontSize: getComputedStyle(node).fontSize, fontFamily: getComputedStyle(node).fontFamily, lineHeight: getComputedStyle(node.firstElementChild).height, background: getComputedStyle(node.closest(".xterm").querySelector(".xterm-viewport")).backgroundColor }));
    assert.equal(rendered.fontSize, "18px");assert.ok(rendered.fontFamily.includes("Menlo"));
    assert.equal(rendered.background, "rgb(250, 250, 250)");
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.waitForFunction(() => document.querySelector(".xterm-cursor-bar"));
    const current = engines.flatMap(fixtureNativeSessions);
    for (const session of original) {
      const live = current.find(row => row.id === session.id);
      assert.equal(live?.pid, session.pid, "[TC-PDDESKTOP-025] preferences preserves live sessions");
      assert.ok(live.cols < session.cols && live.rows < session.rows, "[TC-PDDESKTOP-025] font metrics resize the same upstream session");
    }
    await page.screenshot({ path: join(directory, "terminal-applied.png"), scale: "css" });
    await application.close();application = undefined;
    page = await launch();
    assert.deepEqual(await page.evaluate(() => window.pdmuxDesktop.preferences.read()), wanted);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".xterm-rows")).fontSize === "18px");
    for (const session of original) assert.equal(engines.flatMap(fixtureNativeSessions).find(row => row.id === session.id)?.pid, session.pid);
    await page.screenshot({ path: join(directory, "restarted.png"), scale: "css" });
    await page.locator('[data-testid="shell-user"]').click();await page.locator('[data-testid="desktop-menu-settings"]').click();
    await page.locator('[data-testid="desktop-general-settings"]').getByRole("button", { name: "Language", exact: true }).click();
    assert.equal(await page.getByRole("menuitem").count(), 2);
    await page.getByRole("menuitem").nth(1).click();
    const korean = JSON.parse(await readFile(resolve("apps/web/src/lib/i18n/catalogs/app/ko.json"), "utf8"));
    await page.getByRole("heading", { name: korean.desktop.preferences.title, level: 1, exact: true }).waitFor();
    await page.locator('[data-testid="settings-tab-terminal"]').click();await page.locator('[data-testid="terminal-settings-form"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="terminal-settings-save"]').disabled);
    await page.screenshot({ path: join(directory, "settings-korean.png"), scale: "css" });
    const result = { result: "passed", runtime: "Electron", privateProfile: true, nativeSessionsPreserved: true, persistenceAcrossLaunches: true, koreanSettingsVerified: true, untrustedWindowRejected: true, invalidSettingsRejected: true, menu: before, geometry, routes, rendered, preferences: wanted };
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));console.log(JSON.stringify(result));
  }
} finally {
  await application?.close().catch(() => {});
  await stopFixtureNativeSessions(profile).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
