import { expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";

// The switch is an application flag (APP_FLAG_SETTINGS), so it is on the admin
// Settings page's Application tab. Turning MCP off changes every caller's /mcp, so
// the test runs in the exclusive phase.
test("admin can disable the MCP endpoint and restore it live", { tag: "@exclusive" }, async ({ page }) => {
  await ready(page, "/admin/settings");
  await page.getByRole("tab", { name: "Application" }).click();
  const toggle = page.getByRole("switch", { name: "MCP (Model Context Protocol)" });
  await expect(toggle).toBeVisible();
  const original = await toggle.isChecked();

  async function setEnabled(enabled: boolean): Promise<void> {
    if ((await toggle.isChecked()) === enabled) return;
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/account/settings")
        && response.request().method() === "PUT",
    );
    await toggle.click();
    expect((await saved).ok()).toBeTruthy();
    if (enabled) await expect(toggle).toBeChecked();
    else await expect(toggle).not.toBeChecked();
  }

  // What an MCP client sends: a JSON-RPC body. A body-less POST is refused before it
  // reaches /mcp by a built web server's cross-site form check (403), which the dev
  // server skips.
  const call = () => page.request.post("/mcp", { data: { jsonrpc: "2.0", id: 1, method: "initialize" } });

  try {
    await setEnabled(true);
    await expect(async () => {
      expect((await call()).status()).toBe(401);
    }).toPass({ timeout: 5_000 });

    await setEnabled(false);
    // The endpoint reads the database through a short cross-replica cache. Poll the
    // externally visible contract instead of assuming this request hits the writer.
    await expect(async () => {
      expect((await call()).status()).toBe(404);
    }).toPass({ timeout: 5_000 });
  } finally {
    await setEnabled(original);
  }
});
