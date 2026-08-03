import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// Sorting via the shared DataTable. Users is server-sorted (manual), audit is
// client-sorted — both drive the same clickable headers + aria-sort.
test("users table sorts by a column header (server)", async ({ page }) => {
  await ready(page, "/admin/users");
  const header = page.getByRole("columnheader", { name: /Name/ });
  // Click the sort button *inside* the header — a bare name match collides with
  // the sidebar user button (a "Renamed" account contains "name").
  const sortByName = header.getByRole("button");
  const firstName = () => page.getByRole("row").nth(1).getByRole("cell").first().innerText();

  await sortByName.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await page.waitForTimeout(400); // server refetch
  const asc = await firstName();

  await sortByName.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await page.waitForTimeout(400);
  const desc = await firstName();

  expect(asc).not.toBe(desc); // order flipped
});

test("audit table sorts client-side", async ({ page }) => {
  await ready(page, "/admin/audit");
  test.skip((await page.getByRole("row").count()) < 3, "not enough audit entries");
  await page.getByRole("button", { name: "When" }).click(); // default desc -> asc
  await expect(page.getByRole("columnheader", { name: /When/ })).toHaveAttribute("aria-sort", "ascending");
});

test("users table keeps responsive headers and cells aligned", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "/admin/users");
  const table = page.getByRole("table", { name: "Users" });
  const visibleHeaders = table.locator("thead th:visible");
  const visibleCells = table.locator("tbody tr").first().locator("td:visible");

  await expect(table.getByRole("columnheader", { name: "Role" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "Status" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "Joined" })).toBeHidden();
  expect(await visibleHeaders.count()).toBe(await visibleCells.count());
});
