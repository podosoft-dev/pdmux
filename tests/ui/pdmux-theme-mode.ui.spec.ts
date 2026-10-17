import { expect, test, type Page } from "@playwright/test";
import { hydrated, ready } from "../helpers/hydration";

/**
 * The theme the visitor picks in the shell is named on <html>.
 *
 * PodoKit's theme-mode spec checks this on the page that renders its AccountMenu, and
 * pdmux has none (`accountMenu: null` in app-paths.ts), so that spec skips here. The
 * shell renders the managed ThemeToggle next to its own user menu, and `@pdmux/ui`
 * follows the `.dark` or `.light` class before the OS setting, so the same check runs
 * on `/account` in the shell.
 */

async function chooseTheme(page: Page, mode: "Light" | "Dark" | "System"): Promise<void> {
  await page.getByTestId("theme-toggle").click();
  await page.getByRole("menuitem", { name: mode }).click();
}

test("the theme chosen in the shell is named on <html> in both modes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page, "/account");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  const html = page.locator("html");

  await chooseTheme(page, "Light");
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);

  // The class is set before the page renders, not only after a choice.
  await page.reload();
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await hydrated(page);

  await chooseTheme(page, "Dark");
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)light(\s|$)/);

  await chooseTheme(page, "System");
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
});
