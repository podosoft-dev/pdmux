import { type Page, expect } from "@playwright/test";

type SidebarState = "open" | "hidden";

/** The sidebar state the SERVER has in the default layout, or `unknown` while it cannot answer. */
async function savedSidebar(page: Page): Promise<SidebarState | "unknown"> {
  const response = await page.request.get("/api/prefs");
  if (!response.ok()) return "unknown";
  const prefs = (await response.json()) as {
    layouts?: { payload?: { sidebarOpen?: unknown }; isDefault?: boolean }[];
  };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  return layout?.payload?.sidebarOpen === false ? "hidden" : "open";
}

/**
 * Toggle the dashboard's sidebar until the shell shows `state`, then wait for the
 * server to have it too.
 */
async function setSidebar(page: Page, state: SidebarState): Promise<void> {
  const shell = page.locator("[data-testid='dashboard-shell']");
  await expect(async () => {
    if ((await shell.getAttribute("data-sidebar")) !== state) {
      await page.locator("[data-testid='toggle-sidebar']").click();
    }
    await expect(shell).toHaveAttribute("data-sidebar", state, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // …and wait for the SERVER to know. Layout writes are debounced, so a full document
  // load right after the click reads the old row — measured: the dashboard said `open`,
  // then a document load of it rendered `hidden`.
  await expect
    .poll(() => savedSidebar(page), { timeout: 10_000, message: "the layout write never reached the server" })
    .toBe(state);
}

/**
 * Make sure the shell's sidebar is showing.
 *
 * It is chrome, not page content — the fleet cards and the way to host management live
 * in it — and its collapsed state is PERSISTED per user. So a spec that reaches for
 * anything inside it cannot assume the previous spec (or the previous person at this
 * browser) left the column open; when it is collapsed the contents are legitimately
 * invisible and every click on them times out. The toggle is on the dashboard only.
 */
export async function openSidebar(page: Page): Promise<void> {
  await setSidebar(page, "open");
}

/** Collapse the dashboard's sidebar and wait until the server has the collapsed layout. */
export async function collapseSidebar(page: Page): Promise<void> {
  await setSidebar(page, "hidden");
}
