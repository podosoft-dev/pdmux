import type { Page } from "@playwright/test";

/**
 * Waits until SvelteKit has attached the current document's event handlers. The
 * root layout adds this marker from onMount, so no fixed timing assumption is
 * needed even while the development server compiles a route for the first time.
 * Call it after `page.reload()` too: the reloaded document is visible, and
 * clickable, before its handlers exist, so an early click does nothing.
 */
export async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated="true"]').waitFor();
}

/** Opens `path` and waits for hydration before a test drives the page. */
export async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await hydrated(page);
}
