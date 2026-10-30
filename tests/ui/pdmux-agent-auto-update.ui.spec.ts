import { expect, test } from "../helpers/pdmux-test";
import { ready } from "../helpers/hydration";
import { mockHost, mockUpdate } from "../helpers/fleet";
import { captureLayout, createHost, layoutOn, restoreLayout } from "../helpers/vm-fleet";

/**
 * Automatic agent updates restart a host's agent on their own schedule. The screen has two
 * halves to show: the switch that allows it, and every pane on that host saying, while it
 * happens, why its terminal is about to drop.
 */
test.describe("automatic agent updates", () => {
  test("[TC-PDUI-254] every pane on a host whose agent is updating says so", { tag: "@exclusive" }, async ({ page }) => {
    // A real row, because the layout the server renders keeps only panes on hosts it knows;
    // the browser's own host list is then answered with that row mid-update.
    const hostId = await createHost(page.request, "e2e-auto-update");
    const busy = mockHost("mock-updating", {
      id: hostId,
      agentVersion: "1.4.0",
      lastUpdate: mockUpdate(0, 1, { phase: "restarting", currentVersion: "1.4.0", targetVersion: "1.5.0" }),
    });
    let hosts = [busy];
    await page.route("**/api/hosts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: hosts });
    });
    const saved = await captureLayout(page.request);
    try {
      await layoutOn(page.request, saved, hostId, 2);
      await ready(page, "/");

      const covers = page.locator("[data-pdmux-pane] [data-pdmux-agent-update]");
      await expect(covers).toHaveCount(2);
      await expect(covers.first()).toBeVisible();
      await expect(covers.first()).toContainText("1.5.0");
      await expect(covers.first()).toHaveAttribute("role", "status");

      // The agent reports back on the new build: the covers go.
      hosts = [{ ...busy, agentVersion: "1.5.0", lastUpdate: mockUpdate(0, 1, { phase: "done", currentVersion: "1.5.0", targetVersion: "1.5.0" }) }];
      await page.reload();
      await expect(page.locator("[data-pdmux-pane]").first()).toBeVisible();
      await expect(covers).toHaveCount(0);
    } finally {
      await restoreLayout(page.request, saved);
      await page.request.delete(`/api/hosts/${hostId}`);
    }
  });

  test("[TC-PDHOST-037] the fleet settings offer automatic agent updates, on by default", async ({ page, playwright, baseURL, e2eState }) => {
    const request = await playwright.request.newContext({ baseURL, storageState: e2eState });
    try {
      const baseline = (await (await request.get("/api/fleet/settings")).json()) as Record<string, unknown>;
      expect(baseline.agentAutoUpdate).toBe(true);

      const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/fleet/settings", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const sent = route.request().postDataJSON() as Record<string, unknown>;
        bodies.push(sent);
        return route.fulfill({ json: { ...baseline, ...sent } });
      });

      await ready(page, "/settings");
      const toggle = page.getByTestId("fleet-agent-auto-update");
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeChecked();

      await toggle.uncheck();
      await page.getByTestId("settings-save").click();
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0]).toEqual({ agentAutoUpdate: false });
    } finally {
      await request.dispose();
    }
  });
});
