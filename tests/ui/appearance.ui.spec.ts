import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default). The Appearance controls live in their
// own "Appearance" settings tab.
async function openAppearance(page: import("@playwright/test").Page): Promise<void> {
  await ready(page, "/admin/settings");
  const tab = page.getByRole("tab", { name: "Appearance" });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("data-state", "active");
  }).toPass();
}

test("appearance: has its own tab with theme controls", async ({ page }) => {
  await openAppearance(page);
  await expect(page.getByRole("heading", { name: "Featured themes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Default", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Violet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zinc" })).toBeHidden();
  await expect(page.getByLabel("Brand color").first()).toBeVisible();
  await expect(page.getByText("Corner style", { exact: true })).toBeVisible();
  await expect(page.getByText("Preview", { exact: true })).toBeVisible();
});

test("appearance: keeps the full preset catalog behind a disclosure", async ({ page }) => {
  await openAppearance(page);
  await page.getByRole("button", { name: "Show more themes" }).click();
  await expect(page.getByRole("button", { name: "Zinc" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Show fewer themes" }).click();
  await expect(page.getByRole("button", { name: "Zinc" })).toBeHidden();
});

test("appearance: preview light/dark toggle switches modes", async ({ page }) => {
  await openAppearance(page);
  await expect(page.getByRole("button", { name: "Light" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dark" })).toBeVisible();
  await page.getByRole("button", { name: "Dark" }).click();
});

test("appearance: advanced reveals per-token pickers", async ({ page }) => {
  await openAppearance(page);
  await page.getByRole("button", { name: "Fine-tune colors" }).click();
  await expect(page.getByRole("button", { name: "Clear color adjustments" })).toBeVisible();
  await expect(page.getByLabel("Primary light")).toBeVisible();
  await page.getByRole("button", { name: "Dark", exact: true }).last().click();
  await expect(page.getByLabel("Primary dark")).toBeVisible();
});

test("appearance: pick a preset, save, apply live, then restore @smoke", async ({ page }) => {
  await openAppearance(page);
  await page.getByRole("button", { name: "Slate" }).click();
  await page.getByRole("button", { name: "Medium" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("General settings saved.").first()).toBeVisible();
  // Applied globally via the scoped override stylesheet.
  await expect.poll(async () => page.locator("#podokit-theme").count()).toBeGreaterThan(0);

  // "Restore defaults" reverts everything in one click and persists.
  await page.getByRole("button", { name: "Restore defaults" }).click();
  await expect(page.getByText("General settings saved.").first()).toBeVisible();
  await expect.poll(async () => page.locator("#podokit-theme").count()).toBe(0);
});
