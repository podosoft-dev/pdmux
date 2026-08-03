import { expect, test } from "@playwright/test";
import { USER, userState } from "../helpers/accounts";
import { expectOnScreen, expectViewportBound } from "../helpers/geometry";
import { ready } from "../helpers/hydration";

/**
 * The account screen, and the way into the platform console.
 *
 * Account used to be a standalone page with its own header and footer, so opening it
 * from the sidebar menu made the fleet disappear — the same complaint that moved host
 * management into the shell. It is a product screen for a signed-in person, so it
 * renders in the right-hand area with the cards still on the left.
 *
 * The admin item is the only route into `/admin` left after that page's header was
 * stripped, so its presence (admin) and absence (member) are both worth freezing.
 */

test.describe("pdmux account", () => {
  test("[TC-PDUI-139] the account screen renders inside the shell", async ({ page }) => {
    await ready(page, "/account");
    const sidebar = page.locator("[data-pdmux-sidebar]");
    const panel = page.locator("[data-testid='account-panel']");
    await expect(page.locator("[data-testid='dashboard-shell']")).toBeVisible();
    await expectOnScreen(sidebar, "host sidebar on /account");
    await expectOnScreen(panel, "account panel");
    // PodoKit's account screen itself, reused whole.
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

    const edges = await page.evaluate(() => {
      const left = document.querySelector("[data-pdmux-sidebar]")?.getBoundingClientRect();
      const right = document.querySelector("[data-testid='account-panel']")?.getBoundingClientRect();
      return {
        sidebarRight: Math.round(left?.right ?? -1),
        panelLeft: Math.round(right?.left ?? -1),
        overflow: getComputedStyle(document.querySelector("[data-testid='account-panel']") as Element).overflowY,
      };
    });
    expect(edges.panelLeft, "the account forms must start right of the sidebar").toBeGreaterThanOrEqual(
      edges.sidebarRight,
    );
    // A long form must scroll in its own column, never lengthen the page.
    expect(edges.overflow).toBe("auto");
    await expectViewportBound(page);

    // The standalone chrome is gone: navigation is the sidebar and the breadcrumb.
    await expect(page.getByRole("button", { name: "Home" })).toHaveCount(0);
    await page.locator("[data-testid='open-dashboard']").click();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.locator("[data-pdmux-grid]")).toBeVisible();
  });

  test("[TC-PDUI-140] an administrator reaches the console from the account menu", async ({ page }) => {
    await ready(page, "/");
    await expect(async () => {
      await page.locator("[data-testid='shell-user']").click();
      await expect(page.locator("[data-testid='shell-user-admin']")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expectOnScreen(page.locator("[data-testid='shell-user-admin']"), "admin console item");

    await page.locator("[data-testid='shell-user-admin']").click();
    await expect(page).toHaveURL(/\/admin$/);
    // The console keeps its own chrome — it is the platform shell, not the product's.
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});

test.describe("pdmux account (member)", () => {
  test.use({ storageState: userState });

  test("[TC-PDUI-140] a member sees no admin entry, and still reaches their account", async ({ page }) => {
    await ready(page, "/");
    await expect(async () => {
      await page.locator("[data-testid='shell-user']").click();
      await expect(page.locator("[data-testid='shell-user-account']")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    // The address lives in the open menu now, not on the trigger — the trigger is an
    // avatar. Asserting it here is what keeps "who am I signed in as?" answerable at all.
    await expect(page.locator("[data-testid='shell-user-identity']")).toContainText(USER.email);
    // Presentation only — /admin still meets PodoKit's own guard — but offering a link
    // that answers 403 is how a product teaches people to distrust its navigation.
    await expect(page.locator("[data-testid='shell-user-admin']")).toHaveCount(0);
    await expect(page.locator("[data-testid='shell-user-signout']")).toBeVisible();

    await page.locator("[data-testid='shell-user-account']").click();
    await expect(page).toHaveURL((url) => url.pathname === "/account");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    // A member gets the same shell: the fleet they work on stays on the left.
    await expectOnScreen(page.locator("[data-pdmux-sidebar]"), "host sidebar for a member");
    await expectViewportBound(page);
  });
});
