import { type Page, expect } from "@playwright/test";

/**
 * Make sure the shell's sidebar is showing.
 *
 * It is chrome, not page content — the fleet cards and the way to host management live
 * in it — and its collapsed state is PERSISTED per user. So a spec that reaches for
 * anything inside it cannot assume the previous spec (or the previous person at this
 * browser) left the column open; when it is collapsed the contents are legitimately
 * invisible and every click on them times out.
 */
export async function openSidebar(page: Page): Promise<void> {
  const shell = page.locator("[data-testid='dashboard-shell']");
  await expect(async () => {
    if ((await shell.getAttribute("data-sidebar")) !== "open") {
      await page.locator("[data-testid='toggle-sidebar']").click();
    }
    await expect(shell).toHaveAttribute("data-sidebar", "open", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // …and wait for the SERVER to know. Layout writes are debounced, so a full document
  // load right after the click reads the old row and the column comes back collapsed —
  // measured: the dashboard said `open`, then `/hosts` rendered `hidden`. Only the
  // dashboard has the toggle, so on `/hosts` there is no way to recover from that.
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/prefs");
        if (!response.ok()) return false;
        const prefs = (await response.json()) as {
          layouts?: { payload?: { sidebarOpen?: unknown }; isDefault?: boolean }[];
        };
        const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
        return layout?.payload?.sidebarOpen !== false;
      },
      { timeout: 10_000, message: "the layout write never reached the server" },
    )
    .toBe(true);
}
