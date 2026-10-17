import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

/**
 * pdmux owns its users page, so `podo update` never replaces it. It carried the
 * 1.2 client filters, where the list endpoint took one filter: picking a role
 * cleared the status and "Active" was missing. This keeps the adopted page on
 * the server-side list, with both filters in one request, at both widths.
 * Read-only: it signs in as the seeded administrator and changes nothing.
 */
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`[TC-PDADMIN-052] the users list filters by role and status together at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await ready(page, "/admin/users");
    const main = page.getByRole("main");
    const triggers = main.locator('button[data-slot="select-trigger"]');
    const role = triggers.nth(0);
    const status = triggers.nth(1);

    await status.click();
    await expect(page.getByRole("option")).toHaveText(["All", "Active", "Pending approval", "Banned"]);
    await page.getByRole("option", { name: "Active", exact: true }).click();
    await role.click();
    await page.getByRole("option", { name: "User", exact: true }).click();
    // Picking a role no longer clears the status.
    await expect(status).toContainText("Active");
    await expect(role).toContainText("User");

    // Other tests add users while this one runs on more than one worker, and the newest
    // come first, so the seeded user can fall off the first page; a search keeps it there.
    await main.locator("#toolbar-search").fill("user@example.com");
    const listed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/admin/users" &&
        url.searchParams.get("role") === "user" && url.searchParams.get("status") === "active" &&
        url.searchParams.get("search") === "user@example.com";
    });
    await main.getByRole("button", { name: "Search", exact: true }).click();
    expect((await listed).ok()).toBeTruthy();
    await expect(main.getByRole("cell", { name: "user@example.com" })).toBeVisible();
    await expect(main.getByRole("cell", { name: "admin@example.com" })).toHaveCount(0);

    // The toolbar wraps inside the viewport; nothing scrolls the page sideways.
    const search = main.getByRole("button", { name: "Search", exact: true });
    const boxes = { role: await role.boundingBox(), status: await status.boundingBox(), search: await search.boundingBox() };
    for (const box of Object.values(boxes)) {
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await testInfo.attach("toolbar-geometry", { body: JSON.stringify({ viewport, boxes, overflow }), contentType: "application/json" });
  });
}
