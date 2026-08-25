import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default)

test("settings: add and remove a social login provider", async ({ page }) => {
  const dialog = page.getByRole("dialog");
  const addBtn = dialog.getByRole("button", { name: "Add provider" });
  const openConfigure = async (): Promise<void> => {
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "Authentication" }).click();
    const socialCard = page
      .getByText("Social login", { exact: true })
      .locator('xpath=ancestor::div[@data-slot="card"]');
    await socialCard.getByRole("button", { name: "Configure" }).click();
  };

  await ready(page, "/admin/settings");
  // The auth-config catalog can be momentarily unavailable right after another
  // spec toggles auth config (the auth instance rebuilds). Reload until the
  // catalog is loaded (Add provider becomes enabled).
  await expect(async () => {
    await page.reload();
    await openConfigure();
    await expect(addBtn).toBeEnabled({ timeout: 3000 });
  }).toPass({ timeout: 25000 });

  await addBtn.click();
  const provider = dialog.locator("#social-provider");
  await expect(provider).toBeVisible();
  const callback = await dialog.locator("code").textContent();
  const providerId = callback?.trim().split("/").pop() ?? ""; // first addable provider (not hard-coded)
  expect(providerId).not.toBe("");
  const expectedCallback = new URL(`/api/auth/callback/${providerId}`, page.url()).toString();
  expect(callback?.trim()).toBe(expectedCallback);
  try {
    await dialog.locator("#social-id").fill("test-client-id");
    await dialog.locator("#social-secret").fill("test-secret");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    // Save returns to the list view, where the new provider row has an enable switch.
    await expect(dialog.getByRole("switch").first()).toBeVisible();
    const saved = await (await page.request.get("/api/account/auth-config")).json();
    expect(saved.social[providerId].redirectURI).toBe(expectedCallback);
  } finally {
    if (providerId) {
      await page.request
        .put("/api/account/auth-config", { data: { social: { [providerId]: { delete: true } } } })
        .catch(() => undefined);
    }
  }
});

test("settings: open and save the SMTP dialog", async ({ page }) => {
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Authentication" }).click();
  await page.getByRole("button", { name: "SMTP settings" }).click();
  const dialog = page.getByRole("dialog");
  try {
    // Point at the same Mailpit the env already uses, so saving can't re-route mail
    // for the other email specs.
    await dialog.locator("#smtp-host").fill("localhost");
    await dialog.locator("#smtp-port").fill("1125");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Setting updated").first()).toBeVisible();
  } finally {
    // Reset SMTP so the config store falls back to environment for later specs.
    await page.request
      .put("/api/account/auth-config", { data: { smtp: { enabled: false, host: "", port: 587, user: "", from: "", secure: false } } })
      .catch(() => undefined);
  }
});

test("settings: configure automatic logout", async ({ page }) => {
  await page.request.put("/api/account/auth-config", {
    data: { server: { sessionIdleTimeoutMinutes: null } },
  });
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Authentication" }).click();

  const toggle = page.getByRole("switch", { name: "Automatic logout" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  const card = page
    .getByText("Automatic logout", { exact: true })
    .locator('xpath=ancestor::div[@data-slot="card"]');
  await card.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Idle time (minutes)").fill("45");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("45 min", { exact: true })).toBeVisible();

  const saved = await (await page.request.get("/api/account/auth-config")).json();
  expect(saved.server.sessionIdleTimeoutMinutes).toBe(45);
  const caps = await (await page.request.get("/api/account/capabilities")).json();
  expect(caps.sessionIdleTimeoutMinutes).toBe(45);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
