import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/pdmux-test";
import { expectOnScreen } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { ASLEEP, RUNNING, type Fleet, type SavedLayout, captureLayout, createHost, layoutOn, machine, restoreLayout, serveMachine } from "../helpers/vm-fleet";

/**
 * Powering a host's machine from its terminal panes, and every pane agreeing about it.
 *
 * The machine is the server's `HostView.vm`; here a real host row carries a `vm` block that the
 * test owns, served to BOTH browser contexts from one state — exactly how the server's row is one
 * truth for every screen. The provider is not involved: the power route is answered by the test,
 * which moves the state the way the server would (claim → change → result). Against a real
 * provider the same screens were driven on 2026-10-19 (`docs/workspace/VM-PROVIDER-2026-10.md`).
 */

const veils = (page: Page, phase: string) => page.locator(`[data-testid=vm-veil][data-pdmux-vm-phase=${phase}]`);

test.describe.serial("pdmux VM power from terminals", () => {
  let hostId = "";
  let saved: SavedLayout | null = null;

  test.beforeAll(async ({ request }) => {
    saved = await captureLayout(request);
    hostId = await createHost(request, "e2e-vm");
  });

  test.afterAll(async ({ request }) => {
    await restoreLayout(request, saved);
    if (hostId) await request.delete(`/api/hosts/${hostId}`);
  });

  test("[TC-PDVM-024] the pane header offers the state's power changes, default first, forced last", async ({ page }) => {
    const fleet: Fleet = { hostId, vm: machine("running", RUNNING), online: true, requests: [] };
    await serveMachine(page.context(), fleet);
    await layoutOn(page.request, saved, hostId, 1);
    await ready(page, "/");

    const power = page.locator("[data-pdmux-pane] [data-pdmux-vm-power]");
    await expect(power).toHaveAttribute("data-pdmux-vm-state", "running");
    await power.click();
    const menu = page.getByTestId("vm-power-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-pdmux-vm-action]")).toHaveText([/Sleep/, /Restart/, /Shut down/, /Force off/, /Force restart/]);
    await expect(menu.locator("[data-pdmux-vm-kind=primary]")).toHaveAttribute("data-pdmux-vm-action", "hibernate");
    // Within the screen and not clipped by the pane it was opened from.
    await expectOnScreen(menu, "power menu");

    // Restart asks first, and says how many terminals it will cut — at least this screen's pane.
    await menu.locator("[data-pdmux-vm-action=reboot]").click();
    const confirm = page.getByTestId("vm-power-confirm");
    await expect(confirm).toContainText("1");
    // Scoped to the dialog: the page also lists commits, and a subject can say "cancel".
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    expect(fleet.requests).toEqual([]);
  });

  test("[TC-PDVM-025] two screens, four panes: one sleep reaches every pane, nothing is offered meanwhile, and waking brings them all back", async ({ page, browser, e2eState }) => {
    const fleet: Fleet = { hostId, vm: machine("running", RUNNING), online: true, requests: [] };
    await serveMachine(page.context(), fleet);
    await layoutOn(page.request, saved, hostId, 2);
    await ready(page, "/");
    const other = await browser.newContext({ storageState: e2eState });
    await serveMachine(other, fleet);
    const second = await other.newPage();
    // A second screen on the same machine. It signs in as the same worker (accounts are per
    // worker here), so it reads the same two panes — four panes on two screens in all. That the
    // server refuses a second claim (409, with who holds it) is the service spec's job
    // (`vm-operations.service.spec.ts`); this one measures what every screen shows.
    await ready(second, "/");

    // Sleep from the first pane.
    await page.locator("[data-pdmux-pane]").first().locator("[data-pdmux-vm-power]").click();
    await page.locator("[data-pdmux-vm-action=hibernate]").click();
    await page.getByTestId("vm-power-confirm-confirm").click();
    expect(fleet.requests).toEqual(["hibernate"]);

    // Every pane on both screens shows the change in flight and who asked for it.
    await expect(veils(page, "busy")).toHaveCount(2);
    await expect(veils(second, "busy")).toHaveCount(2, { timeout: 15_000 });
    await expect(veils(second, "busy").first()).toContainText("Alice");

    // Meanwhile the other screen offers no power change at all.
    await second.locator("[data-pdmux-pane]").first().locator("[data-pdmux-vm-power]").click();
    await expect(second.getByTestId("vm-power-menu").locator("[data-pdmux-vm-action]")).toHaveCount(0);
    await second.keyboard.press("Escape");

    // The machine is asleep: every pane says so and offers to wake it.
    fleet.vm = machine("hibernated", ASLEEP);
    fleet.online = false;
    await expect(veils(page, "asleep")).toHaveCount(2, { timeout: 15_000 });
    await expect(veils(second, "asleep")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator("[data-pdmux-vm-power]").first()).toHaveAttribute("data-pdmux-vm-state", "hibernated");

    // The other person wakes it from their pane; nothing asks first.
    await second.getByTestId("vm-veil-action").first().click();
    await expect.poll(() => fleet.requests).toEqual(["hibernate", "start"]);
    await expect(veils(second, "busy")).toHaveCount(2);

    // Back: no pane on either screen is veiled any more.
    fleet.vm = machine("running", RUNNING);
    fleet.online = true;
    await expect(page.getByTestId("vm-veil")).toHaveCount(0, { timeout: 15_000 });
    await expect(second.getByTestId("vm-veil")).toHaveCount(0, { timeout: 15_000 });
    await other.close();
  });

  test("[TC-PDVM-026] the veil and its button sit inside the pane, on screen", async ({ page }) => {
    const fleet: Fleet = { hostId, vm: machine("hibernated", ASLEEP), online: false, requests: [] };
    await serveMachine(page.context(), fleet);
    await layoutOn(page.request, saved, hostId, 2);
    await ready(page, "/");
    const pane = page.locator("[data-pdmux-pane]").first();
    const veil = pane.locator("[data-pdmux-veil]");
    await expect(veil).toBeVisible({ timeout: 15_000 });
    const [paneBox, veilBox, buttonBox] = await Promise.all([pane.boundingBox(), veil.boundingBox(), pane.getByTestId("vm-veil-action").boundingBox()]);
    expect(paneBox && veilBox && buttonBox).toBeTruthy();
    if (!paneBox || !veilBox || !buttonBox) return;
    expect(veilBox.width).toBeGreaterThan(0);
    expect(veilBox.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(veilBox.x + veilBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
    await expectOnScreen(pane.getByTestId("vm-veil-action"), "wake button");
    // The button is a real target: a click reaches it through the pass-through veil.
    await pane.getByTestId("vm-veil-action").click();
    await expect.poll(() => fleet.requests).toEqual(["start"]);
  });

  test("[TC-PDVM-027] the host page shows the machine with its power changes, links one and unlinks it", async ({ page }) => {
    const fleet: Fleet = { hostId, vm: machine("running", RUNNING), online: true, requests: [] };
    await serveMachine(page.context(), fleet);
    const calls: string[] = [];
    await page.route(`**/api/hosts/${hostId}/vm`, async (route) => {
      calls.push(route.request().method());
      if (route.request().method() === "DELETE") {
        fleet.vm = undefined as unknown as typeof fleet.vm;
        await route.fulfill({ json: { hostId, name: "e2e-vm-500" } });
      } else {
        fleet.vm = machine("stopped", { ...ASLEEP });
        await route.fulfill({ json: fleet.vm });
      }
    });
    await page.route("**/api/vm/providers", (route) => route.fulfill({ json: [{ id: "00000000-0000-4000-8000-0000000000p1", kind: "proxmox", name: "lab", baseUrl: "https://pve.example.test:8006", tokenId: "pdmux@pve!t", caFingerprint: null, defaults: {}, sleepRequiresTag: null, backupBeforeSleep: null, lastTestedAt: null, lastErrorCode: null, machineCount: 1 }] }));
    await page.route("**/api/vm/providers/*/catalog", (route) => route.fulfill({ json: { nodes: [{ name: "node-1", online: true }], templates: [], storages: [], bridges: [], pools: [] } }));

    await ready(page, `/hosts/${hostId}`);
    const card = page.getByTestId("host-vm");
    await expect(card.getByTestId("host-vm-state")).toHaveText("Running", { timeout: 15_000 });
    await expect(card.getByTestId("host-vm-actions").locator("[data-pdmux-vm-action]")).toHaveCount(5);

    // Unlink: asks first, then the card offers linking instead.
    await card.getByTestId("host-vm-unlink").click();
    await page.getByTestId("host-vm-unlink-confirm-confirm").click();
    await expect.poll(() => calls).toEqual(["DELETE"]);
    await page.reload();
    await expect(page.getByTestId("host-vm-link")).toBeVisible({ timeout: 15_000 });

    // Link: the single provider and its single online node are chosen for you; the id is typed.
    await page.getByTestId("host-vm-vmid").fill("500");
    await expect(page.getByTestId("host-vm-link-submit")).toBeEnabled();
    await page.getByTestId("host-vm-link-submit").click();
    await expect.poll(() => calls).toEqual(["DELETE", "PUT"]);
    await expect(page.getByTestId("host-vm-state")).toHaveText("Off", { timeout: 15_000 });
  });
});
