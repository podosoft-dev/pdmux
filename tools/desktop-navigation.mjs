import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Drive the persistent navigation and the two settings destinations through the UI. */
export async function verifyDesktopNavigation(page, directory, connected = false) {
  await mkdir(directory, { recursive: true });
  const origin = new URL(page.url()).origin;
  const prefix = connected ? "connected" : "local";
  const hosts = await page.evaluate(async () => (await fetch("/api/hosts")).json());
  const routes = ["/connection", "/hosts", "/settings", "/access", ...hosts.slice(0, 1).map(host => `/hosts/${host.id}`)];
  const measurements = [];
  for (const route of routes) {
    await page.goto(origin + route);
    await page.locator('html[data-hydrated="true"]').waitFor();
    const panel = page.getByTestId("settings-dialog");
    await panel.waitFor();
    const close = page.getByTestId("settings-close");
    assert.equal(await panel.getByTestId("open-dashboard").count(), 0, "[TC-PDDESKTOP-019] modal settings has no dashboard action");
    const geometry = await panel.evaluate(node => ({ bounds: node.getBoundingClientRect().toJSON(), documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
    const backBox = await close.boundingBox();
    const titleBox = await panel.getByRole("heading", { name: "Settings", exact: true }).boundingBox();
    const navigation = await panel.getByRole("tablist").first().boundingBox();
    const content = await panel.locator('[data-testid^="settings-content-"][data-state="active"]').boundingBox();
    assert.ok(navigation && content && navigation.x + navigation.width <= content.x && content.width > 300 && content.height > 150, "[TC-PDDESKTOP-019] left tabs leave usable settings content");
    assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, "[TC-PDDESKTOP-019] no horizontal overflow");
    measurements.push({ route, backBox, titleBox, ...geometry });
    await page.screenshot({ path: join(directory, `${prefix}-${route.slice(1).replaceAll("/", "-")}.png`) });
    await close.click();
    await page.waitForURL(url => url.pathname === "/");
    await page.locator('[data-pdmux-grid]').waitFor();
  }
  await page.goto(origin + "/settings");
  await page.locator('html[data-hydrated="true"]').waitFor();
  await page.setViewportSize({ width: 900, height: 700 });
  const tabs = page.getByTestId("settings-tabs");
  assert.ok((await tabs.boundingBox()).width > 650, "[TC-PDDESKTOP-019] settings remains usable at a smaller desktop size");
  await page.screenshot({ path: join(directory, `${prefix}-narrow-settings.png`) });
  await page.setViewportSize({ width: 1440, height: 928 });

  assert.equal(await page.locator('[data-testid="cloudflare-integration"]').count(), 0, "[TC-PDDESKTOP-020] no server integration in local settings");
  assert.equal(await page.locator('[data-testid="settings-target-server"]').isDisabled(), !connected);
  if (connected) {
    const localField = page.locator('[data-testid="fleet-field-heartbeatSec"]:visible');
    await localField.fill("19");
    let saved = page.waitForResponse(response => response.url().endsWith("/api/fleet/settings") && response.request().method() === "PUT");
    await page.locator('[data-testid="settings-save"]').click();
    assert.equal((await saved).status(), 200);
    await page.locator('[data-testid="settings-target-server"]:visible').click();
    await page.locator('[data-testid="settings-target-server"][data-state="active"]:visible').waitFor();
    await page.locator('[data-testid="cloudflare-integration"]:visible').waitFor();
    const serverField = page.locator('[data-testid="fleet-field-heartbeatSec"]:visible');
    await serverField.fill("37");
    saved = page.waitForResponse(response => response.url().endsWith("/api/desktop/server/fleet/settings") && response.request().method() === "PUT");
    await page.locator('[data-testid="settings-save"]').click();
    assert.equal((await saved).status(), 200);
    const settings = await page.evaluate(async () => Promise.all(["/api/fleet/settings", "/api/desktop/server/fleet/settings"].map(async path => (await fetch(path)).json())));
    assert.equal(settings[0].heartbeatSec, 19, "[TC-PDDESKTOP-020] preserve the local setting");
    assert.equal(settings[1].heartbeatSec, 37, "[TC-PDDESKTOP-020] save the server setting on its backend");
    await page.screenshot({ path: join(directory, "connected-server-settings.png") });
    await page.locator('[data-testid="settings-target-local"]:visible').click();
    await page.locator('[data-testid="settings-target-local"][data-state="active"]:visible').waitFor();
    assert.equal(await page.locator('[data-testid="fleet-field-heartbeatSec"]:visible').inputValue(), "19");
  }
  await writeFile(join(directory, `${prefix}-geometry.json`), JSON.stringify(measurements, null, 2));
  await page.getByTestId("settings-close").click();
  await page.waitForURL(url => url.pathname === "/");
}
