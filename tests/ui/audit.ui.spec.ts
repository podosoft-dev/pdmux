import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default). The Audit log page is gated by the
// audit-log module; skip when it isn't installed in the generated app.
test("admin can view audit entries when the module is installed", async ({ page }) => {
  await ready(page, "/admin");
  const auditNav = page.getByRole("link", { name: "Audit log" });
  test.skip((await auditNav.count()) === 0, "audit-log module not installed");

  await auditNav.click();
  await expect(page).toHaveURL(/\/admin\/audit/);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  // seed sign-ins are audited via the better-auth hook, so an action row is present
  await expect(page.getByText("auth.login").first()).toBeVisible();
});
