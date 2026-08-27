import { expect, type Locator, type Page } from "@playwright/test";

// Wait for SvelteKit to attach client event handlers before driving forms. The
// root layout adds this marker from onMount, so no fixed timing assumption is
// needed even while the development server compiles a route for the first time.
export async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('html[data-hydrated="true"]').waitFor();
}

/**
 * Click until the interaction's client-rendered result is visible.
 *
 * The hydration marker prevents the common pre-hydration race. A retry still matters
 * for product dialogs reached through client navigation, where the trigger can be
 * replaced while the next route finishes rendering.
 */
export async function clickUntil(page: Page, trigger: string, revealed: Locator): Promise<void> {
  await expect(async () => {
    await page.locator(trigger).click();
    await expect(revealed).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}
