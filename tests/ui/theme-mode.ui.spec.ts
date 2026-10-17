import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// mode-watcher marks <html> with `.dark` or `.light`, so component libraries
// that follow either class, and fall back to the OS setting otherwise, match the
// theme the visitor chose rather than the system one.
test("the chosen theme is named on <html> in both modes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page, "/account");
  const html = page.locator("html");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);

  // The class is set before the page renders, not only after a choice.
  await page.reload();
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)light(\s|$)/);

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: "System" }).click();
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
});
