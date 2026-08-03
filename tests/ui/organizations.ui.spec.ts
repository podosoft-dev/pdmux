import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// admin storageState (project default) — organizations is an admin-only view
test("admin can create an organization @smoke", async ({ page }) => {
  await ready(page, "/admin");
  const nav = page.getByRole("link", { name: "Organizations" });
  test.skip((await nav.count()) === 0, "organizations not enabled");
  await nav.click();
  await expect(page).toHaveURL(/\/admin\/organizations/);
  await page.getByRole("button", { name: "New organization" }).click();
  const name = `Acme ${Date.now()}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Organization created").first()).toBeVisible();
  await expect(page.getByRole("cell", { name })).toBeVisible();
  // clean up so the shared admin account keeps no leftover org
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Organization deleted").first()).toBeVisible();
});

test("create an org with a non-ascii name, a parent, and a manager", async ({ page }) => {
  await ready(page, "/admin/organizations");
  const newBtn = page.getByRole("button", { name: "New organization" });
  test.skip((await newBtn.count()) === 0, "organizations not enabled");

  // Parent org first (Korean name → slug falls back, so it still saves).
  const parent = `본사 ${Date.now()}`;
  await newBtn.click();
  await page.getByLabel("Name", { exact: true }).fill(parent);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Organization created").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: parent })).toBeVisible();

  // Child org: pick the parent + a manager (an existing user).
  const child = `영업 ${Date.now()}`;
  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Name", { exact: true }).fill(child);
  await page.locator("#o-parent").click();
  await page.getByRole("option", { name: parent }).click();
  await page.getByRole("checkbox").first().click(); // first existing user as a manager
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Organization created").first()).toBeVisible();
  // child row shows the parent org name
  await expect(page.getByRole("row", { name: new RegExp(child) })).toContainText(parent);

  // Clean up. Delete the child first (its row also shows the parent name, so a
  // parent-name match isn't unique until the child is gone), and wait for the
  // child row to disappear before removing the parent.
  await page.getByRole("row", { name: new RegExp(child) }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Organization deleted").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: child, exact: true })).toHaveCount(0);
  await page.getByRole("row", { name: new RegExp(parent) }).getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText("Organization deleted").first()).toBeVisible();
});

test("organization manage: remove a member, invite one, and cancel the invite", async ({ page }) => {
  await ready(page, "/admin/organizations");
  const newBtn = page.getByRole("button", { name: "New organization" });
  test.skip((await newBtn.count()) === 0, "organizations not enabled");

  const name = `Mng ${Date.now()}`;
  await newBtn.click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  // Seed a specific non-owner member (the admin is always the owner, so pick the
  // seeded user — .first() is order-dependent and could hit the owner).
  await page.locator("label", { hasText: "user@example.com" }).getByRole("checkbox").click();
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Organization created").first()).toBeVisible();

  try {
    await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Manage" }).click();
    const dialog = page.getByRole("dialog");

    // The seeded non-owner member is removable.
    const remove = dialog.getByRole("button", { name: "Remove" }).first();
    await expect(remove).toBeVisible();
    await remove.click();

    // Invite a member by email → pending invitation appears → cancel it.
    await dialog.locator("#invite-email").fill(`invitee-${Date.now()}@example.com`);
    await dialog.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByText("Invitation sent").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).first().click();
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Delete" }).first().click();
    await expect(page.getByText("Organization deleted").first()).toBeVisible();
  }
});
