import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { verifySettingsDialog } from "./settings-dialog-ui.mjs";

// [TC-PDDESKTOP-026] Reuse an explicitly supplied development fixture session.
// No account creation, server settings writes, or existing browser profiles.
const state = process.env.PDMUX_SETTINGS_STORAGE_STATE;
if (!state) throw new Error("Set PDMUX_SETTINGS_STORAGE_STATE to a disposable fixture's storage state");
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const directory = resolve(process.env.PDMUX_SETTINGS_EVIDENCE ?? "output/playwright/settings-modal");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ storageState: state, ...(mobile ? { ...devices["Pixel 7"], viewport: { width: 320, height: 740 } } : { viewport: { width: 1440, height: 928 }, deviceScaleFactor: 2 }) });
    try {
      if (mobile) await context.addCookies([{ name: "locale", value: "ko", url: baseURL }]);
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      const response = await page.goto(baseURL);
      try { await page.locator('html[data-hydrated="true"]').waitFor(); }
      catch (error) { await page.screenshot({ path: join(directory, "load-failure.png"), scale: "css" }); console.error(JSON.stringify({ url: page.url(), status: response?.status(), pageErrors })); throw error; }
      if (mobile) {
        for (const tab of ["hosts", "terminal", "git", "files"]) assert.equal(await page.getByTestId(`shell-tab-${tab}`).isVisible(), true, "Actual mobile navigation is present");
        await page.getByTestId("shell-tab-hosts").click();
        assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0 && /Mobile/.test(navigator.userAgent)), true);
      }
      await page.screenshot({ path: join(directory, mobile ? "mobile-dashboard.png" : "web-dashboard.png"), scale: "css" });
      const result = await verifySettingsDialog(page, join(directory, mobile ? "mobile-320-ko" : "web"));
      assert.deepEqual(pageErrors, [], "No client runtime errors");
      console.log(JSON.stringify({ result: result.result, mobile, viewport: result.measurements[0].viewport, dashboardPreserved: result.dashboardPreserved }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
