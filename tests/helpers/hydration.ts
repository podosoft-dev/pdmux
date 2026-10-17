import type { Page } from "@playwright/test";

// Wait for SvelteKit to attach client event handlers before driving forms. The
// root layout adds this marker from onMount, so no fixed timing assumption is
// needed even while the development server compiles a route for the first time.
export async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('html[data-hydrated="true"]').waitFor();
}
