import { expect, type Locator, type Page } from "@playwright/test";

// SvelteKit dev hydration can attach event handlers slightly after load;
// wait for the page to settle before driving client-only interactions.
export async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);
}

/**
 * Click until the thing it opens is actually there.
 *
 * A dev-mode SvelteKit route hydrates after `load`, and a click that lands in that
 * window is swallowed with no error at all — the test then waits for a dialog that was
 * never told to open. Retrying the trigger is the documented remedy in this
 * repository's UI testing rules, and it lives here rather than in one spec because
 * every dialog-opening trigger in the product has the same race.
 */
export async function clickUntil(page: Page, trigger: string, revealed: Locator): Promise<void> {
  await expect(async () => {
    await page.locator(trigger).click();
    await expect(revealed).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}
