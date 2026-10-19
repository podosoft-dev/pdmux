import assert from "node:assert/strict";
import { chromium, devices, _electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyTerminalFonts } from "./terminal-font-ui.mjs";
import { stopFixtureNativeSessions } from "./native-session-fixture.mjs";

// [TC-PDDESKTOP-025] Requires D2Coding installed on the validation computer.
const directory = resolve(process.env.PDMUX_FONT_EVIDENCE ?? "output/playwright/terminal-fonts");
if (process.argv.includes("--web")) {
  const state = process.env.PDMUX_SETTINGS_STORAGE_STATE;
  assert.ok(state, "Supply a disposable development fixture's storage state");
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    for (const mobile of [false, true]) {
      const baseURL = process.env.E2E_BASE_URL ?? "http://pdmux.localhost";
      const context = await browser.newContext({ storageState: state, ...(mobile ? { ...devices["Pixel 7"], viewport: { width: 320, height: 740 } } : { viewport: { width: 1440, height: 928 }, deviceScaleFactor: 2 }) });
      try {
        await context.grantPermissions(["local-fonts"], { origin: baseURL });
        await context.addCookies([{ name: "locale", value: "ko", url: baseURL }]);
        const page = await context.newPage(); await page.goto(baseURL);
        await page.locator('html[data-hydrated="true"]').waitFor({ timeout: 60_000 });
        if (mobile) {
          for (const tab of ["hosts", "terminal", "git", "files"]) assert.equal(await page.getByTestId(`shell-tab-${tab}`).isVisible(), true);
          await page.getByTestId("shell-tab-hosts").click();
        }
        const result = await verifyTerminalFonts(page, join(directory, mobile ? "mobile" : "web"), { loadFonts: true });
        console.log(JSON.stringify({ result: result.result, mobile, controls: result.controls, previewFonts: result.previewFonts }));
      } finally { await context.close(); }
    }
    for (const supported of [true, false]) {
      const baseURL = process.env.E2E_BASE_URL ?? "http://pdmux.localhost";
      const context = await browser.newContext({ storageState: state, viewport: { width: 1000, height: 800 } });
      try {
        if (supported) await context.grantPermissions([], { origin: baseURL });
        else await context.addInitScript(() => Object.defineProperty(window, "queryLocalFonts", { value: undefined, configurable: true }));
        const page = await context.newPage(); await page.goto(baseURL);
        await page.locator('html[data-hydrated="true"]').waitFor();
        await page.getByTestId("shell-user").click(); await page.getByTestId("shell-user-settings").click(); await page.getByTestId("settings-tab-terminal").click();
        if (supported) await page.getByTestId("terminal-fonts-load").click();
        const status = page.getByTestId("terminal-fonts-status");
        await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="terminal-fonts-status"]')?.textContent));
        if (supported) assert.match(await status.innerText(), /Could not read installed fonts/, "Denied access is reported instead of a successful empty inventory");
        else assert.match(await status.innerText(), /cannot list installed fonts/);
        assert.equal(await page.getByTestId("terminal-font").isEnabled(), true);
        await page.getByTestId("terminal-font").click();
        assert.equal(await page.getByRole("option", { name: "D2Coding", exact: true }).count(), 0, "Denied or unsupported access never fabricates installed fonts");
        await page.getByRole("option").last().click();
        await page.getByTestId("terminal-custom-font").fill("D2Coding");
        const previewFamily = await page.getByTestId("terminal-preview").evaluate(node => getComputedStyle(node).fontFamily);
        assert.ok(previewFamily.includes("D2Coding"), "Manual font choice remains available");
        await page.screenshot({ path: join(directory, supported ? "web-permission-denied.png" : "web-api-unavailable.png"), scale: "css" });
        console.log(JSON.stringify({ result: "passed", case: supported ? "denied" : "unsupported", status: await status.innerText() }));
        await page.getByTestId("settings-cancel").click();
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
} else {
  const root = await mkdtemp(join(tmpdir(), "pdmux-font-ui-"));
  const profile = join(root, "profile");
  const executablePath = process.env.PDMUX_ELECTRON_EXECUTABLE;
  let application;
  try {
    application = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [resolve("apps/desktop")]), `--user-data-dir=${profile}`, "--use-mock-keychain"], env: { ...process.env, TMUX: "", PDMUX_DESKTOP_AGENT_RELEASE_DIR: resolve("apps/web/static/agent") }, timeout: 90_000 });
    assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), profile);
    const page = await application.firstWindow();
    await page.locator('html[data-hydrated="true"]').waitFor({ timeout: 90_000 });
    await page.waitForFunction(async () => (await window.pdmuxDesktop.localAgent.status()).phase === "ready", undefined, { timeout: 45_000 });
    await page.locator(".xterm-rows").first().waitFor();
    const result = await verifyTerminalFonts(page, join(directory, "desktop"), { terminal: true });
    console.log(JSON.stringify(result));
  } finally {
    await application?.close().catch(() => {});
    await stopFixtureNativeSessions(profile).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
