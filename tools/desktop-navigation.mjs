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
    const dashboard = page.locator('[data-testid="shell-toolbar"] [data-testid="open-dashboard"]');
    assert.equal(await dashboard.count(), 1, "[TC-PDDESKTOP-019] every page has a persistent dashboard button");
    assert.equal(await page.locator('[data-testid="shell-breadcrumb"]').count(), 0, "[TC-PDDESKTOP-019] no duplicate breadcrumb navigation");
    const geometry = await page.locator('[data-testid="shell-toolbar"]').evaluate(toolbar => {
      const bounds = toolbar.getBoundingClientRect();
      const buttons = [...toolbar.querySelectorAll('a, button')].filter(element => element.getBoundingClientRect().width > 0).map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, buttons, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    assert.ok(geometry.bounds.height >= 28 && geometry.bounds.width >= 200);
    assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, "[TC-PDDESKTOP-019] the shell has no horizontal overflow");
    for (const button of geometry.buttons) {
      assert.ok(button.width >= 20 && button.height >= 20);
      assert.ok(button.x >= geometry.bounds.x - 1 && button.x + button.width <= geometry.bounds.x + geometry.bounds.width + 1, "[TC-PDDESKTOP-019] toolbar controls fit their sidebar");
    }
    measurements.push({ route, ...geometry });
    await page.screenshot({ path: join(directory, `${prefix}-${route.slice(1).replaceAll("/", "-")}.png`) });
    await dashboard.click();
    await page.waitForURL(url => url.pathname === "/");
    await page.locator('[data-pdmux-grid]').waitFor();
  }
  await page.goto(origin + "/settings");
  await page.locator('html[data-hydrated="true"]').waitFor();
  await page.setViewportSize({ width: 900, height: 700 });
  const splitter = page.locator('[data-testid="dashboard-shell"] > [data-pdmux-handle]').first();
  let handle = await splitter.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(180, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const narrow = await page.locator('[data-testid="shell-toolbar"]').evaluate(toolbar => {
    const bounds = toolbar.getBoundingClientRect();
    const controls = [...toolbar.querySelectorAll('a,button')].map(element => element.getBoundingClientRect().toJSON()).filter(rect => rect.width > 0);
    return { bounds: bounds.toJSON(), controls };
  });
  for (let i = 0; i < narrow.controls.length; i += 1) {
    const control = narrow.controls[i];
    assert.ok(control.left >= narrow.bounds.left - 1 && control.right <= narrow.bounds.right + 1, "[TC-PDDESKTOP-019] controls fit the narrowed sidebar");
    for (const other of narrow.controls.slice(i + 1)) assert.ok(control.right <= other.left || other.right <= control.left || control.bottom <= other.top || other.bottom <= control.top, "[TC-PDDESKTOP-019] controls never overlap");
  }
  await page.screenshot({ path: join(directory, `${prefix}-narrow-settings.png`) });
  measurements.push({ route: "/settings", viewport: "900x700", ...narrow });
  handle = await splitter.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
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
