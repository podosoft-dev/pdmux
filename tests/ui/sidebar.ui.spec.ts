import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default)
test("collapsing the sidebar hides the brand instead of overflowing", async ({ page }) => {
  await ready(page, "/admin");
  const brand = page.getByTestId("sidebar-brand");
  const toggle = page.getByRole("button", { name: "Toggle Sidebar" });
  await expect(brand).toBeVisible();

  await toggle.click();
  await expect(brand).toBeHidden(); // icon-collapsed: label is hidden, not spilling out

  await toggle.click();
  await expect(brand).toBeVisible();
});
