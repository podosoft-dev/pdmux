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
    const dashboard = page.locator('.pdmux-shell > [data-pdmux-region="page"] [data-testid="open-dashboard"]');
    assert.equal(await dashboard.count(), 1, "[TC-PDDESKTOP-019] every page header has a dashboard button");
    assert.equal(await page.locator('[data-testid="shell-toolbar"] [data-testid="open-dashboard"]').count(), 0, "[TC-PDDESKTOP-019] the sidebar has no dashboard button");
    assert.equal(await page.locator('[data-testid="shell-breadcrumb"]').count(), 0, "[TC-PDDESKTOP-019] no duplicate breadcrumb navigation");
    const panel = page.locator('[data-testid="desktop-settings"]');
    const geometry = await panel.evaluate(node => ({ bounds: node.getBoundingClientRect().toJSON(), documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
    const backBox = await dashboard.boundingBox();
    const titleBox = await panel.getByRole("heading", { level: 1 }).boundingBox();
    assert.ok(backBox && titleBox && backBox.x + backBox.width <= titleBox.x && backBox.y < titleBox.y + titleBox.height && titleBox.y < backBox.y + backBox.height, "[TC-PDDESKTOP-019] return stays left of the settings title");
    const navigation = await panel.getByRole("tablist").first().boundingBox();
    const content = await panel.getByRole("tabpanel").first().boundingBox();
    assert.ok(navigation && content && navigation.x + navigation.width <= content.x && content.width > 300 && content.height > 150, "[TC-PDDESKTOP-019] left tabs never collapse the settings content");
    assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, "[TC-PDDESKTOP-019] no horizontal overflow");
    measurements.push({ route, backBox, titleBox, ...geometry });
    await page.screenshot({ path: join(directory, `${prefix}-${route.slice(1).replaceAll("/", "-")}.png`) });
    await dashboard.click();
    await page.waitForURL(url => url.pathname === "/");
    await page.locator('[data-pdmux-grid]').waitFor();
  }
  await page.goto(origin + "/settings");
  await page.locator('html[data-hydrated="true"]').waitFor();
  await page.setViewportSize({ width: 900, height: 700 });
  const tabs = page.locator('[data-testid="desktop-settings-tabs"]');
  assert.ok((await tabs.boundingBox()).width > 700, "[TC-PDDESKTOP-019] settings remains usable at a smaller desktop size");
  await page.screenshot({ path: join(directory, `${prefix}-narrow-settings.png`) });
  await page.setViewportSize({ width: 1440, height: 928 });

  assert.equal(await page.locator('[data-testid="cloudflare-integration"]').count(), 0, "[TC-PDDESKTOP-020] no server integration in local settings");
  assert.equal(await page.locator('[data-testid="settings-target-server"]').isDisabled(), !connected);
  if (connected) {
    const localField = page.locator('[data-testid="fleet-field-heartbeatSec"]');
    await localField.fill("19");
    let saved = page.waitForResponse(response => response.url().endsWith("/api/fleet/settings") && response.request().method() === "PUT");
    await page.locator('[data-testid="fleet-save"]').click();
    assert.equal((await saved).status(), 200);
    await page.locator('[data-testid="settings-target-server"]').click();
    await page.waitForURL(url => url.searchParams.get("scope") === "server");
    await page.locator('[data-testid="cloudflare-integration"]').waitFor();
    const serverField = page.locator('[data-testid="fleet-field-heartbeatSec"]');
    await serverField.fill("37");
    saved = page.waitForResponse(response => response.url().endsWith("/api/desktop/server/fleet/settings") && response.request().method() === "PUT");
    await page.locator('[data-testid="fleet-save"]').click();
    assert.equal((await saved).status(), 200);
    const settings = await page.evaluate(async () => Promise.all(["/api/fleet/settings", "/api/desktop/server/fleet/settings"].map(async path => (await fetch(path)).json())));
    assert.equal(settings[0].heartbeatSec, 19, "[TC-PDDESKTOP-020] preserve the local setting");
    assert.equal(settings[1].heartbeatSec, 37, "[TC-PDDESKTOP-020] save the server setting on its backend");
    await page.screenshot({ path: join(directory, "connected-server-settings.png") });
    await page.locator('[data-testid="settings-target-local"]').click();
    await page.waitForURL(url => !url.search);
    assert.equal(await page.locator('[data-testid="fleet-field-heartbeatSec"]').inputValue(), "19");
  }
  await writeFile(join(directory, `${prefix}-geometry.json`), JSON.stringify(measurements, null, 2));
  await page.locator('[data-testid="open-dashboard"]').click();
  await page.waitForURL(url => url.pathname === "/");
}
