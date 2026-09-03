import { expect, test } from "@playwright/test";
import { e2eAdminState } from "../helpers/accounts";
import { clickUntil, ready } from "../helpers/hydration";

test.use({ storageState: e2eAdminState });

test("[TC-PDUI-227] configures the fleet connection without ever rendering the token", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/integrations/cloudflare", async (route) => {
    const method = route.request().method();
    calls.push(method);
    if (method === "GET") return route.fulfill({ json: null });
    if (method === "PUT") {
      return route.fulfill({
        json: {
          connected: true,
          tokenConfigured: true,
          accountId: "account-1",
          zoneId: "zone-1",
          zoneName: "example.com",
          baseDomain: "apps.example.com",
          accessPolicyId: "policy-1",
          accessPolicyName: "Team members",
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
      });
    }
    return route.fallback();
  });
  await page.route("**/api/integrations/cloudflare/discover", (route) => {
    calls.push("DISCOVER");
    return route.fulfill({
      json: {
        zones: [{ id: "zone-1", name: "example.com", accountId: "account-1", accountName: "Example" }],
        policies: [{ id: "policy-1", name: "Team members", accountId: "account-1" }],
      },
    });
  });

  await ready(page, "/settings");
  const card = page.locator("[data-testid='cloudflare-integration']");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await page.locator("[data-testid='cloudflare-token']").fill("cloudflare-secret-token");
  await page.locator("[data-testid='cloudflare-discover']").click();
  await expect(page.locator("[data-testid='cloudflare-discovery']")).toBeVisible();
  await page.locator("[data-testid='cloudflare-domain']").fill("apps.example.com");
  await page.locator("[data-testid='cloudflare-connect']").click();
  await expect(page.locator("[data-testid='cloudflare-summary']")).toContainText("apps.example.com");
  await expect(card).not.toContainText("cloudflare-secret-token");
  expect(calls).toContain("DISCOVER");
  expect(calls).toContain("PUT");

  const bounds = await card.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});

test.describe("mobile service exposure", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("[TC-PDUI-228] keeps the exposure action reachable and uses a viewport-bound dialog", async ({ page, request }) => {
    const label = `e2e-cloudflare-${Date.now().toString().slice(-6)}`;
    const created = await request.post("/api/hosts", { data: { label, address: "127.0.0.1" } });
    expect(created.ok()).toBe(true);
    const host = await created.json() as { id: string };
    const serviceResponse = await request.post(`/api/hosts/${host.id}/services`, {
      data: { label: "Mobile API", port: 4173, probe: "http" },
    });
    expect(serviceResponse.ok()).toBe(true);
    try {
      await ready(page, `/hosts/${host.id}`);
      await clickUntil(
        page,
        "[data-testid='service-menu-Mobile API']",
        page.locator("[data-testid='service-expose-Mobile API']"),
      );
      await page.locator("[data-testid='service-expose-Mobile API']").click();
      const dialog = page.locator("[data-testid='service-exposure-form']");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeLessThanOrEqual(1);
      expect(box!.y).toBeLessThanOrEqual(1);
      expect(box!.width).toBeGreaterThanOrEqual(388);
      expect(box!.height).toBeGreaterThanOrEqual(842);
      await expect(page.locator("[data-testid='service-exposure-settings']")).toBeVisible();
    } finally {
      await request.delete(`/api/hosts/${host.id}`);
    }
  });
});
