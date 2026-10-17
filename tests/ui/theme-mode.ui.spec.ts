import { expect, test, type Page } from "@playwright/test";
import { hydrated, ready } from "../helpers/hydration";
import { paths } from "../helpers/paths";

async function chooseTheme(page: Page, mode: "Light" | "Dark" | "System"): Promise<void> {
  await page.getByTestId("theme-toggle").click();
  await page.getByRole("menuitem", { name: mode }).click();
}

// mode-watcher marks <html> with `.dark` or `.light`, so component libraries
// that follow either class, and fall back to the OS setting otherwise, match the
// theme the visitor chose rather than the system one. The managed ThemeToggle
// renders on the page app-paths.ts names as the account menu page.
test("the chosen theme is named on <html> in both modes", async ({ page }) => {
  test.skip(paths.accountMenu === null, "no page renders the theme toggle (tests/helpers/app-paths.ts)");
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page, paths.accountMenu ?? "/");
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
