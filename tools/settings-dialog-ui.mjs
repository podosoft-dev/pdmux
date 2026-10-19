import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** [TC-PDDESKTOP-026] Shared real-rendering contract for web and Electron. */
export async function verifySettingsDialog(page, directory, { desktop = false } = {}) {
  await mkdir(directory, { recursive: true });
  const origin = new URL(page.url()).origin;
  const start = await page.evaluate(() => {
    const grid = document.querySelector("[data-pdmux-grid]");
    if (grid) grid.__settingsProbe = "preserved";
    return { sidebar: document.querySelector('[data-testid="dashboard-shell"]').getAttribute("data-sidebar"), path: location.pathname, view: document.querySelector('[data-testid="dashboard-shell"]').getAttribute("data-view") };
  });
  async function open() {
    await page.getByTestId("shell-user").click();
    const menu = page.getByTestId("shell-user-menu");
    await menu.waitFor();
    for (const id of ["nav-hosts", "nav-settings", "nav-access", "desktop-menu-backup", "desktop-menu-data", "desktop-menu-updates"]) assert.equal(await menu.getByTestId(id).count(), 0);
    await page.getByTestId("shell-user-settings").click();
    await page.getByTestId("settings-dialog").waitFor();
    assert.equal(new URL(page.url()).pathname, start.path);
  }
  await open();
  const frame = page.getByTestId("settings-dialog");
  async function geometry() {
    const result = await frame.evaluate(node => {
      const rect = selector => node.querySelector(selector)?.getBoundingClientRect().toJSON();
      return { bounds: node.getBoundingClientRect().toJSON(), nav: rect('[role="tablist"]'), body: rect('[data-testid^="settings-content-"][data-state="active"]'), footer: rect('[data-testid="settings-footer"]'), close: rect('[data-testid="settings-close"]'), buttons: [...node.querySelectorAll('[data-testid="settings-footer"] button')].map(button => button.getBoundingClientRect().toJSON()), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, documentWidth: document.documentElement.scrollWidth };
    });
    assert.ok(result.nav && result.body && result.nav.right <= result.body.x && result.body.width >= 190 && result.body.height > 150, "Left tabs leave usable content");
    assert.ok(result.bounds.x >= 0 && result.bounds.y >= 0 && result.bounds.right <= result.viewport.width + 1 && result.bounds.bottom <= result.viewport.height + 1);
    assert.ok(result.footer.bottom <= result.bounds.bottom + 1 && result.buttons.every(button => button.x >= result.bounds.x && button.right <= result.bounds.right && button.bottom <= result.bounds.bottom), "Footer actions fit inside the dialog");
    assert.equal(await frame.getByTestId("open-dashboard").count(), 0);
    assert.ok(result.documentWidth <= result.viewport.width + 1);
    return result;
  }
  const measurements = [{ tab: "general", ...await geometry() }];
  const footer = page.getByTestId("settings-footer");
  const previousStyle = await footer.getAttribute("style");
  try {
    // Negative control: recreate the primitive's old -mb-4 clipping regression.
    await footer.evaluate(node => { node.style.marginBottom = "-16px"; });
    await assert.rejects(geometry, /Footer actions fit/);
  } finally { await footer.evaluate((node, value) => { if (value === null) node.removeAttribute("style"); else node.setAttribute("style", value); }, previousStyle); }

  await page.getByTestId("settings-tab-terminal").click();
  const size = page.getByTestId("terminal-font-size");
  await size.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="terminal-font-size"]').disabled);
  const fontControls = await page.getByTestId("terminal-settings-form").evaluate(node => {
    const rect = id => node.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().toJSON();
    return { font: rect("terminal-font"), size: rect("terminal-font-size") };
  });
  assert.equal(fontControls.font.height, fontControls.size.height, "Font select and size input have equal heights");
  if (fontControls.font.x !== fontControls.size.x) assert.ok(Math.abs(fontControls.font.y - fontControls.size.y) <= 1, "Font select and size input align despite the help button");
  const initial = await size.inputValue();
  const changed = initial === "18" ? "19" : "18";
  await size.fill(changed);
  assert.equal(await page.getByTestId("settings-save").isEnabled(), true);
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("settings-tab-terminal").click();
  assert.equal(await size.inputValue(), changed, "Switching tabs preserves unsaved input");
  await size.fill("99");
  assert.equal(await page.getByTestId("settings-save").isDisabled(), true);
  assert.equal(await page.getByTestId("settings-ok").isDisabled(), true);
  await page.getByTestId("settings-cancel").click();
  await frame.waitFor({ state: "hidden" });
  await open(); await page.getByTestId("settings-tab-terminal").click();
  assert.equal(await size.inputValue(), initial, "Cancel discards unsaved changes");
  await size.fill(changed); await page.getByTestId("settings-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-save"]').disabled);
  assert.equal(await frame.isVisible(), true, "Save keeps settings open");
  await page.screenshot({ path: join(directory, "terminal-saved.png"), scale: "css" });
  await page.getByTestId("settings-close").click();
  await open(); await page.getByTestId("settings-tab-terminal").click();
  assert.equal(await size.inputValue(), changed, "Saved changes survive reopening");
  await size.fill(initial); await page.getByTestId("settings-ok").click();
  await frame.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.querySelector("[data-pdmux-grid]")?.__settingsProbe), "preserved", "Settings never remounts the dashboard");
  assert.equal(await page.getByTestId("dashboard-shell").getAttribute("data-sidebar"), start.sidebar);
  await open();
  // General appearance is a draft too: selecting a theme must not apply it early.
  const theme = page.getByTestId("settings-theme");
  const originalTheme = (await theme.innerText()).trim();
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await theme.click();
  await page.getByRole("option").nth(wasDark ? 0 : 1).click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), wasDark);
  await page.getByTestId("settings-cancel").click(); await open();
  assert.equal((await theme.innerText()).trim(), originalTheme);
  await theme.click(); await page.getByRole("option").nth(wasDark ? 0 : 1).click();
  await page.getByTestId("settings-save").click();
  await page.waitForFunction(wasDark => document.documentElement.classList.contains("dark") !== wasDark, wasDark);
  await theme.click(); await page.getByRole("option", { name: originalTheme, exact: true }).click();
  await page.getByTestId("settings-ok").click(); await frame.waitFor({ state: "hidden" }); await open();

  const language = page.getByTestId("settings-language");
  const originalLanguage = (await language.innerText()).trim();
  const originalLang = await page.evaluate(() => document.documentElement.lang);
  await language.click(); await page.getByRole("option").nth(originalLang === "ko" ? 0 : 1).click();
  assert.equal(await page.evaluate(() => document.documentElement.lang), originalLang);
  await page.getByTestId("settings-cancel").click(); await open();
  assert.equal((await language.innerText()).trim(), originalLanguage);
  await language.click(); await page.getByRole("option").nth(originalLang === "ko" ? 0 : 1).click();
  await page.getByTestId("settings-save").click();
  await page.waitForFunction(original => document.documentElement.lang !== original && !document.querySelector('[data-testid="settings-close"]').disabled, originalLang);
  assert.equal(await frame.isVisible(), true);
  await language.click(); await page.getByRole("option", { name: originalLanguage, exact: true }).click();
  await page.getByTestId("settings-ok").click(); await frame.waitFor({ state: "hidden" }); await open();

  // Mock only PUTs so a footer regression cannot change the shared development fleet.
  await page.getByTestId("settings-tab-fleet").click();
  await page.getByTestId("fleet-field-heartbeatSec").waitFor();
  const fleet = await page.evaluate(async () => (await fetch("/api/fleet/settings")).json());
  const writes = [];
  const mockSave = async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const patch = route.request().postDataJSON(); writes.push(patch);
    await route.fulfill({ json: { ...fleet, ...patch } });
  };
  await page.route("**/api/fleet/settings", mockSave);
  try {
    const heartbeat = page.getByTestId("fleet-field-heartbeatSec");
    await heartbeat.fill(String(fleet.heartbeatSec === 31 ? 32 : 31));
    await page.getByTestId("settings-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-save"]').disabled && !document.querySelector('[data-testid="settings-close"]').disabled);
    assert.deepEqual(writes, [{ heartbeatSec: fleet.heartbeatSec === 31 ? 32 : 31 }]);
    // Arming deletion still requires the original typed confirmation; canceling it
    // must unblock the parent footer without applying anything.
    if (fleet.staleHostRetentionDays === 0) {
      await page.getByTestId("fleet-tab-sweep").click();
      await page.getByTestId("fleet-field-staleHostRetentionDays").fill("30");
      await page.getByTestId("settings-save").click();
      const confirmation = page.getByTestId("fleet-sweep-confirm");
      await confirmation.waitFor();
      await confirmation.locator('[data-slot="dialog-footer"] button').first().click();
      await confirmation.waitFor({ state: "hidden" });
      await page.waitForFunction(() => !document.querySelector('[data-testid="settings-close"]').disabled);
      assert.equal(writes.length, 1, "Canceling destructive confirmation sends no settings write");
    }
    await page.getByTestId("settings-cancel").click();
  } finally { await page.unroute("**/api/fleet/settings", mockSave); }
  await open();
  for (const tab of ["general", "hosts", "fleet", "access", ...(desktop ? ["connection", "advanced"] : []), "terminal"]) {
    await page.getByTestId(`settings-tab-${tab}`).click();
    const panel = page.getByTestId(`settings-content-${tab}`);
    await panel.waitFor();
    const content = { general: "desktop-general-settings", hosts: "hosts-panel", fleet: "fleet-settings-panel", access: "mcp-tokens", connection: "desktop-connection", advanced: "desktop-settings-data", terminal: "terminal-settings-form" }[tab];
    await panel.getByTestId(content).waitFor();
    if (tab === "fleet" && desktop) {
      assert.equal(await panel.getByTestId("settings-target-server").isDisabled(), true);
      assert.equal(await panel.getByTestId("cloudflare-integration").count(), 0);
    }
    if (tab === "fleet" && !desktop) {
      // [TC-PDVM-027] Integrating the modal must retain the incoming provider UI.
      await panel.getByTestId("fleet-tab-integrations").click();
      const providers = panel.getByTestId("vm-providers");
      await providers.waitFor();
      const bounds = await providers.boundingBox();
      assert.ok(bounds && bounds.width > 150 && bounds.height > 50, "VM providers remain usable inside modal settings");
    }
    if (tab === "hosts") {
      await page.getByTestId("host-add").click();
      await page.getByTestId("host-form").waitFor();
      await page.getByTestId("host-form").locator('[data-slot="dialog-close"]').click();
      await page.getByTestId("host-form").waitFor({ state: "hidden" });
      assert.equal(await frame.isVisible(), true, "Closing a nested dialog keeps settings open");
      const hostLink = panel.locator('a[data-testid^="host-open-"]').first();
      if (await hostLink.count()) {
        await hostLink.click(); await page.getByTestId("host-title").waitFor();
        assert.equal(new URL(page.url()).pathname, start.path, "Host details stay inside settings");
        assert.equal(await frame.getByTestId("open-dashboard").count(), 0);
        await page.screenshot({ path: join(directory, "host-details.png"), scale: "css" });
        await page.getByTestId("settings-hosts-back").click();
        await page.getByTestId("hosts-panel").waitFor();
      }
    }
    for (const toast of await page.locator('[data-sonner-toast][data-visible="true"]').all()) {
      const box = await toast.boundingBox();
      const buttons = await frame.locator('[data-testid="settings-footer"] button').all();
      for (const button of buttons) {
        const action = await button.boundingBox();
        assert.ok(!box || !action || box.x >= action.x + action.width || box.x + box.width <= action.x || box.y >= action.y + action.height || box.y + box.height <= action.y, "Settings actions are not covered by notifications");
      }
    }
    measurements.push({ tab, ...await geometry() });
    await page.screenshot({ path: join(directory, `${tab}.png`), scale: "css" });
  }
  await page.getByTestId("settings-close").click();
  // Old in-product links take the same path without a document or route replacement.
  await page.evaluate(() => { const link = document.createElement("a"); link.href = "/hosts"; link.dataset.testid = "legacy-settings-probe"; link.textContent = "Hosts"; document.body.append(link); });
  await page.getByTestId("legacy-settings-probe").click();
  await page.getByTestId("hosts-panel").waitFor();
  assert.equal(new URL(page.url()).pathname, start.path);
  assert.equal(await page.evaluate(() => document.querySelector("[data-pdmux-grid]")?.__settingsProbe), "preserved");
  await page.getByTestId("settings-close").click();
  await page.evaluate(() => document.querySelector('[data-testid="legacy-settings-probe"]').remove());
  assert.equal(await page.getByTestId("dashboard-shell").getAttribute("data-view"), start.view, "Saving settings preserves the mobile region");
  const result = { result: "passed", desktop, runtime: await page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform, dpr: devicePixelRatio })), origin: origin.startsWith("http://127.0.0.1") ? "isolated-local-runtime" : "local-development", cancelDiscards: true, saveKeepsOpen: true, okSavesAndCloses: true, dashboardPreserved: true, mobileRegionPreserved: true, clippingNegativeControlRejected: true, measurements };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
