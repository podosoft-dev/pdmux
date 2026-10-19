import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { anonState } from "../helpers/accounts";
import { NETWORK_CHANGED_ANNOTATION, PAGE_ERROR_GRACE_MS, ready } from "../helpers/hydration";

// The hydration helper every UI spec starts with fails on a page that cannot
// hydrate instead of waiting for the test timeout, and says why.
// admin storageState (project default)

async function failure(run: Promise<void>): Promise<string> {
  return run.then(
    () => "hydrated",
    (error: unknown) => String(error),
  );
}

// Only requests the browser dropped for a network change earn a second load.
function reloadedForNetworkChange(): boolean {
  return test.info().annotations.some((annotation) => annotation.type === NETWORK_CHANGED_ANNOTATION);
}

test("ready() waits for an error page rendered inside the app", async ({ page }) => {
  const missing = page.waitForResponse((response) => response.url().endsWith("/hydration-check-missing-page"));
  await ready(page, "/hydration-check-missing-page");
  expect((await missing).status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
});

test("ready() fails at once on the server's static error page", async ({ page }) => {
  // What SvelteKit sends when a server hook or the root layout fails.
  const errorPage = readFileSync(join(__dirname, "../../apps/web/src/error.html"), "utf8")
    .replace(/%sveltekit\.status%/g, "500")
    .replace(/%sveltekit\.error\.message%/g, "Internal Error");
  let loads = 0;
  await page.route("**/hydration-check-error-page", (route) => {
    loads++;
    return route.fulfill({ status: 500, contentType: "text/html", body: errorPage });
  });

  const started = Date.now();
  const message = await failure(ready(page, "/hydration-check-error-page"));

  expect(message).toContain("The server sent SvelteKit's static error page (src/error.html)");
  expect(message).toContain("/hydration-check-error-page (status 500)");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(loads).toBe(1);
  expect(reloadedForNetworkChange()).toBe(false);
});

test.describe("signed out", () => {
  test.use({ storageState: anonState });

  test("ready() names the failed requests of a page that never hydrates", async ({ page }) => {
    // Without its scripts the server-rendered page stays visible but never hydrates.
    let loads = 0;
    await page.route("**/*", (route) => {
      if (route.request().resourceType() === "document") loads++;
      return route.request().resourceType() === "script" ? route.abort() : route.continue();
    });

    const started = Date.now();
    const message = await failure(ready(page, "/login"));

    expect(message).toContain(`The page threw an uncaught error and had not hydrated ${PAGE_ERROR_GRACE_MS / 1000} s later`);
    expect(message).toMatch(/\/login \(status 200\) shows/);
    expect(message).toContain("Page errors:");
    expect(message).toMatch(/Failed requests:\n {2}GET \S+: net::ERR_FAILED/);
    expect(Date.now() - started).toBeLessThan(PAGE_ERROR_GRACE_MS + 10_000);
    expect(loads).toBe(1);
    expect(reloadedForNetworkChange()).toBe(false);
  });
});
