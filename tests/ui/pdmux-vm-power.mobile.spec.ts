import { expect, test } from "../helpers/pdmux-test";
import { expectOnScreen } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { ASLEEP, type SavedLayout, captureLayout, createHost, layoutOn, machine, restoreLayout, serveMachine, stopServing } from "../helpers/vm-fleet";

/**
 * The same power controls on a phone: the pane is the whole screen, so the veil's button and
 * the header's menu must be reachable and big enough for a finger. The machine is a test-owned
 * `vm` block on a real host row, as in `pdmux-vm-power.ui.spec.ts`.
 */

test.describe.serial("pdmux VM power on a phone", () => {
  test.afterEach(async ({ page }) => {
    await stopServing(page.context());
  });

  let hostId = "";
  let saved: SavedLayout | null = null;

  test.beforeAll(async ({ request }) => {
    saved = await captureLayout(request);
    hostId = await createHost(request, "e2e-vm-phone");
  });

  test.afterAll(async ({ request }) => {
    await restoreLayout(request, saved);
    if (hostId) await request.delete(`/api/hosts/${hostId}`);
  });

  test("[TC-PDVM-026] a sleeping machine's pane offers a finger-sized wake button and an on-screen power menu", async ({ page }) => {
    await serveMachine(page.context(), { hostId, vm: machine("hibernated", ASLEEP), online: false, requests: [] });
    await layoutOn(page.request, saved, hostId, 1);
    await ready(page, "/");

    const pane = page.locator("[data-pdmux-pane]").first();
    const wake = pane.getByTestId("vm-veil-action");
    await expect(wake).toBeVisible({ timeout: 15_000 });
    await expectOnScreen(wake, "wake button");
    const box = await wake.boundingBox();
    expect(box?.height ?? 0, "a finger needs 44px").toBeGreaterThanOrEqual(44);

    const power = pane.locator("[data-pdmux-vm-power]");
    const trigger = await power.boundingBox();
    expect(trigger?.height ?? 0, "the header control is finger-sized on a phone").toBeGreaterThanOrEqual(44);
    await power.click();
    const menu = page.getByTestId("vm-power-menu");
    await expect(menu).toBeVisible();
    await expectOnScreen(menu, "power menu");
    await expect(menu.locator("[data-pdmux-vm-action]")).toHaveText([/Wake/]);
  });
});
