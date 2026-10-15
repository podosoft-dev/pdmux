import { expect, test, type Response } from "@playwright/test";
import { ready } from "../helpers/hydration";

// Sorting via the shared DataTable. Users sorts on the server (manual mode
// refetches through Better Auth listUsers), and the audit log asks the server
// for the other time order — both drive the same clickable headers + aria-sort.
test("users table sorts by a column header (server)", async ({ page }) => {
  await ready(page, "/admin/users");
  const header = page.getByRole("columnheader", { name: /Name/ });
  // Click the sort button *inside* the header — a bare name match collides with
  // the sidebar user button (a "Renamed" account contains "name").
  const sortByName = header.getByRole("button");
  const firstName = (): Promise<string> => page.getByRole("row").nth(1).getByRole("cell").first().innerText();
  const sortedBy = (direction: string): Promise<Response> => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/admin/list-users" &&
      url.searchParams.get("sortBy") === "name" &&
      url.searchParams.get("sortDirection") === direction;
  });

  const ascending = sortedBy("asc");
  await sortByName.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await (await ascending).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const asc = await firstName();

  const descending = sortedBy("desc");
  await sortByName.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await (await descending).finished();
  // order flipped
  await expect(page.getByRole("row").nth(1).getByRole("cell").first()).not.toHaveText(asc);
});

test("audit table sorts by time on the server", async ({ page }) => {
  await ready(page, "/admin/audit");
  const table = page.getByRole("table", { name: "Audit log" });
  await expect(table.getByRole("row").nth(1)).toBeVisible();
  test.skip((await table.getByRole("row").count()) < 4, "not enough audit entries");
  const ascending = page.waitForResponse((response) =>
    response.url().includes("/api/audit-logs?") && response.url().includes("order=asc"),
  );
  await table.getByRole("button", { name: "When" }).click(); // default desc -> asc
  await expect(table.getByRole("columnheader", { name: /When/ })).toHaveAttribute("aria-sort", "ascending");
  const entries = (await (await ascending).json()) as Array<{ createdAt: string }>;
  const times = entries.map((entry) => Date.parse(entry.createdAt));
  expect(times).toEqual([...times].sort((left, right) => left - right));
  // Only time can be sorted: the other headers are plain labels.
  await expect(table.getByRole("columnheader", { name: "Action" }).getByRole("button")).toHaveCount(0);
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
