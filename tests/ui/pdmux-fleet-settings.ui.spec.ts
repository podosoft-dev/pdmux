import { expect, test } from "@playwright/test";
import { clickUntil, ready } from "../helpers/hydration";
import { openSidebar } from "../helpers/shell";
import { e2eAdminState } from "../helpers/accounts";

/** A marker written onto a live element; it survives only if the element does. */
type Marked = HTMLElement & { __pdmuxMark?: number };
const MARK = 5107;

/**
 * The fleet's settings, from the screen.
 *
 * Every one of these used to be reachable only with `curl` — including the switch that
 * turns on automatic deletion of hosts that have gone silent, which is exactly the
 * setting nobody should have to write a raw HTTP call to find. So what these specs
 * measure is not "the form renders": it is that the screen REFUSES what the API would
 * refuse (beside the field, before the request), SENDS only what changed, and does not
 * let anyone arm host deletion without being told what it takes.
 *
 * ⚠ THE CURRENT VALUES COME FROM THE SERVER LOADER, so `page.route` cannot fabricate
 * them — the shell reads `/api/fleet/settings` in `+layout.server.ts` and a browser
 * route never sees that request (the same constraint TC-PDWEB-018 records). The GETs
 * are therefore real and only the WRITES are intercepted, which is also what keeps
 * these specs from changing the settings of the fleet this deployment actually uses.
 */

// Its own account, as every pdmux spec uses: fleet settings are scoped per account
// (`personal:<userId>`), so writing them as somebody else would retune their agents.
test.use({ storageState: e2eAdminState });

/** A fleet row as `GET /hosts` returns it — enough of one for the sidebar and the sweep. */
type MockHost = Record<string, unknown>;
function mockHost(label: string, lastSeenAt: string | null): MockHost {
  return {
    id: `00000000-0000-4000-8000-${label.replace(/\W/g, "").slice(-12).padStart(12, "0")}`,
    label,
    address: null,
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "1.5.0",
    latestAgentVersion: "1.5.0",
    agentVersionState: "current",
    lastUpdate: null,
    os: "linux",
    arch: "amd64",
    capabilities: [],
    lastSeenAt,
    online: lastSeenAt !== null,
    connected: false,
    resource: null,
    sessions: [],
    usage: [],
    diagnostics: [],
    services: [],
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test.describe.serial("pdmux fleet settings", () => {
  /**
   * OFF is the state these specs describe, and the state the account has to be left in.
   *
   * It is a precondition rather than an assumption: the sweep is a real server-side job,
   * so a suite account left armed by an earlier run (or an interrupted one) would let it
   * delete rows nobody pointed at — and the "off" copy this suite reads would be a lie
   * about the fleet in front of it.
   */
  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 0 } });
    await request.dispose();
  });

  test("[TC-PDWEB-023] every setting is on one screen, grouped, with the sweep apart", async ({ page }) => {
    /**
     * The defect this screen exists for: fourteen settings, no screen. So the first
     * thing worth asserting is that all fourteen are HERE — a group that quietly drops
     * one recreates the original bug one field at a time.
     *
     * And that they are grouped by blast radius rather than listed: cadence, stored
     * history, caps, lists, and the host sweep on its own. The sweep's card has to say
     * what its non-zero values cost, because a retention number that reads like
     * `metricRetentionDays` is a number people set by analogy.
     */
    // Entered the way an operator enters it: from the dashboard, through the sidebar's
    // own nav. The collapsed state is persisted, so open it rather than assuming — and
    // only the dashboard carries the toggle, so this has to happen before the move.
    await ready(page, "/");
    await openSidebar(page);
    const sidebar = page.locator("[data-pdmux-sidebar]");
    await sidebar.evaluate((el: Marked, mark: number) => (el.__pdmuxMark = mark), MARK);

    await clickUntil(page, "[data-testid='nav-settings']", page.locator("[data-testid='fleet-settings-panel']"));
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator("[data-testid='nav-settings']")).toHaveAttribute("aria-current", "page");
    // In the product shell, beside the fleet it is about — not in the admin console.
    // The cards are the same live element they were on the dashboard, so this is one
    // level inside the shell rather than a screen of its own.
    expect(await sidebar.evaluate((el: Marked) => el.__pdmuxMark ?? null)).toBe(MARK);

    for (const group of ["cadence", "history", "caps", "lists", "sweep"]) {
      await expect(page.locator(`[data-testid='fleet-group-${group}']`)).toBeVisible();
    }
    // ⚠ THE COUNT IS THE POINT. Twelve numbers and two lists; a setting missing from
    // the screen is a setting that is still curl-only.
    await expect(page.locator("[data-testid^='fleet-field-']")).toHaveCount(14);

    // The consequence, not the label: the metric step is the field whose cost is a row
    // count, and the number is the one the API's own comment gives.
    await expect(page.locator("[data-testid='fleet-group-history']")).toContainText("17,000");
    // The bounds are on screen, so an out-of-range value is knowable before it is typed.
    await expect(page.locator("[data-testid='fleet-bounds-heartbeatSec']")).toContainText("3600");

    // The sweep says what is LOST — the cascade is why this is not just another
    // retention number, and it is the only reason a warning here is worth the space.
    const sweep = page.locator("[data-testid='fleet-group-sweep']");
    await expect(sweep).toContainText(/agent tokens|에이전트 토큰/);
    await expect(sweep).toContainText(/re-runs the installer|설치 명령을 다시/);
    // Off is the shipped state and the card says so rather than leaving `0` to be read.
    await expect(page.locator("[data-testid='fleet-sweep-state']")).toContainText(/deleted automatically|자동으로 삭제/);
  });

  test("[TC-PDWEB-026] no group clips its own fields, and the column scrolls instead", async ({ page }) => {
    /**
     * REPORTED, on this screen, before it shipped: only the first field of the
     * first group could be reached. The page did not scroll and every card was cut
     * off mid-field — most of the settings this screen exists to expose were
     * unreachable.
     *
     * ⚠ NO DOM ASSERTION CAN SEE THIS. The inputs are all present, all enabled, and
     * `getBoundingClientRect` returns sane coordinates for a node its ancestor is
     * clipping — a "is it visible" check passes on the broken page. The measurement
     * has to be the overflow itself.
     *
     * The cause: the shell gives this column a fixed height, a flex column shrinks
     * its children by default, and the shadcn card is `overflow-hidden` — so a card
     * with more content than room left silently clips instead of pushing the column
     * into scrolling.
     */
    await ready(page, "/settings");
    await expect(page.locator("[data-testid='fleet-group-sweep']")).toBeAttached();

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid^='fleet-group-']")]
        .filter((card) => card.scrollHeight > card.clientHeight + 2)
        .map((card) => (card as HTMLElement).dataset.testid ?? ""),
    );
    expect(clipped, "these groups are hiding their own fields").toEqual([]);

    // And the column really is the thing that scrolls, so the clipping was not
    // simply traded for a page that ends early.
    const panel = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='fleet-settings-panel']");
      return el ? { scrollH: el.scrollHeight, clientH: el.clientHeight } : null;
    });
    expect(panel).not.toBeNull();
    expect(panel!.scrollH, "the column does not overflow, so nothing proves it scrolls").toBeGreaterThan(
      panel!.clientH,
    );

    // The last control on the longest page must be reachable by scrolling to it.
    const sweep = page.locator("[data-testid='fleet-field-staleHostRetentionDays']");
    await sweep.scrollIntoViewIfNeeded();
    await expect(sweep).toBeInViewport();
  });

  test("[TC-PDWEB-024] an out-of-range value is refused beside the field, and only the change is sent", async ({
    page,
    playwright,
    baseURL,
  }) => {
    /**
     * The failure the operator used to get was a 400 from `curl`. On a screen that is
     * a toast that says "something went wrong" while the field that is wrong sits
     * somewhere above the fold — so the refusal happens here, against the same bounds
     * the API enforces, and the request is never made.
     *
     * ⚠ AND THE BODY IS ASSERTED, not just the fact that one was sent. `PUT
     * /fleet/settings` upserts what it is given, so a form that posted all fourteen
     * would stamp this browser's view over any change made between load and click.
     */
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    try {
      // The real document, so the mocked answer is a whole one — the page re-seeds its
      // form from the PUT's response, and a partial body would blank every other field.
      const baseline = (await (await request.get("/api/fleet/settings")).json()) as Record<string, unknown>;
      const target = baseline.heartbeatSec === 9 ? 8 : 9;

      const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/fleet/settings", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const sent = route.request().postDataJSON() as Record<string, unknown>;
        bodies.push(sent);
        return route.fulfill({ json: { ...baseline, ...sent } });
      });

      await ready(page, "/settings");
      const field = page.locator("[data-testid='fleet-field-heartbeatSec']");
      const save = page.locator("[data-testid='fleet-save']");

      // Nothing typed yet: there is nothing to save, so there is no button to press.
      await expect(save).toBeDisabled();

      await field.fill("0");
      await expect(page.locator("[data-testid='fleet-error-heartbeatSec']")).toContainText(/between 1 and 3600|1 과 3600 사이/);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(save).toBeDisabled();

      // ⚠ THE CONTROL for "refused before the request": force the click anyway. A
      // disabled button that still fired would pass every assertion above.
      await save.click({ force: true });
      expect(bodies, "an out-of-range value reached the server").toHaveLength(0);

      // The other end of the range, and a value that is not a number at all.
      await field.fill("3601");
      await expect(page.locator("[data-testid='fleet-error-heartbeatSec']")).toBeVisible();
      await field.fill("soon");
      await expect(page.locator("[data-testid='fleet-error-heartbeatSec']")).toContainText(/Whole numbers|정수만/);

      // ⚠ THE CONTROL for the refusal itself: an in-range value has to go through,
      // otherwise this spec would pass against a screen that never saves anything.
      await field.fill(String(target));
      await expect(page.locator("[data-testid='fleet-error-heartbeatSec']")).toHaveCount(0);
      await expect(save).toBeEnabled();
      await save.click();

      await expect.poll(() => bodies.length, { message: "the save never left the browser" }).toBe(1);
      // Exactly one key: the one that was typed over. Not fourteen.
      expect(bodies[0]).toEqual({ heartbeatSec: target });
    } finally {
      await request.dispose();
    }
  });

  test("[TC-PDWEB-025] arming host deletion needs the days typed, and names what it would take", async ({
    page,
    playwright,
    baseURL,
  }) => {
    /**
     * `staleHostRetentionDays` is the one setting on this page that destroys something:
     * the delete cascades to the host's agent tokens, enrollment codes, services and
     * collected history, and that machine is refused until somebody registers it again
     * and re-runs the installer. So arming it is a typed confirmation over a list of the
     * machines the window would take today — the same shape as the bulk delete, where
     * what you can be wrong about is a COUNT rather than a name.
     *
     * ⚠ NOTHING IS EVER ARMED AGAINST THE REAL FLEET HERE. The PUT is intercepted, so
     * the 30 typed below never reaches the server; the one value this spec does write
     * is 3650 (ten years), which the sweep cannot act on, and it is put back in
     * `finally`.
     */
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    try {
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 0 } });
      const baseline = (await (await request.get("/api/fleet/settings")).json()) as Record<string, unknown>;

      const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/fleet/settings", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const sent = route.request().postDataJSON() as Record<string, unknown>;
        bodies.push(sent);
        return route.fulfill({ json: { ...baseline, ...sent } });
      });

      const hosts = [
        mockHost("mock-live", daysAgoIso(0)),
        mockHost("mock-quiet-40d", daysAgoIso(40)),
        // Registered, never enrolled. The server's `lastSeenAt < cutoff` cannot match a
        // NULL, so this row is never swept however long it sits there.
        mockHost("mock-never", null),
      ];
      /**
       * ⚠ COUNTED, not looked at. The route intercepts the shell's POLL and not the
       * server render, so the at-risk list is computed from the real fleet until the
       * first poll lands — and this screen shows no host list to watch for it in. The
       * dashboard is deliberately not visited with a fabricated fleet either: its grid
       * is hydrated against the host list, and a slot whose host is absent is dropped.
       */
      let polls = 0;
      await page.route("**/api/hosts", (route) => {
        polls += 1;
        return route.fulfill({ json: hosts });
      });

      await ready(page, "/settings");
      await expect
        .poll(() => polls, { message: "the fabricated fleet never reached the browser" })
        .toBeGreaterThan(0);

      await page.locator("[data-testid='fleet-field-staleHostRetentionDays']").fill("30");
      await expect(page.locator("[data-testid='fleet-save']")).toBeEnabled();
      await clickUntil(page, "[data-testid='fleet-save']", page.locator("[data-testid='fleet-sweep-confirm']"));

      // The click did not save; it asked.
      expect(bodies, "the sweep was armed without a confirmation").toHaveLength(0);

      const details = page.locator("[data-testid='fleet-sweep-confirm-details']");
      await expect(details).toContainText("mock-quiet-40d");
      // ⚠ THE CONTROL for the list: a dialog that named every host would be no more
      // informative than a count. Neither of these is going anywhere at 30 days.
      await expect(details).not.toContainText("mock-live");
      await expect(details).not.toContainText("mock-never");

      const confirm = page.locator("[data-testid='fleet-sweep-confirm-confirm']");
      await expect(confirm).toBeDisabled();
      // The wrong number does not arm it — otherwise the gate is a second button
      // wearing a text field.
      await page.locator("[data-testid='fleet-sweep-confirm-input']").fill("7");
      await expect(confirm).toBeDisabled();
      await page.locator("[data-testid='fleet-sweep-confirm-input']").fill("30");
      await expect(confirm).toBeEnabled();
      await confirm.click();

      await expect.poll(() => bodies.length, { message: "the confirmed save never left" }).toBe(1);
      expect(bodies[0]).toEqual({ staleHostRetentionDays: 30 });

      /**
       * ⚠ THE CONTROL that matters most: turning deletion OFF is NOT gated.
       *
       * A confirmation on every write would pass everything above while making a
       * destructive setting harder to switch off than on. The account is armed at 3650
       * days — long enough that the sweep cannot act on it — and clearing it to 0 has
       * to save straight away.
       */
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 3650 } });
      bodies.length = 0;
      await page.reload();
      await expect(page.locator("[data-testid='fleet-field-staleHostRetentionDays']")).toHaveValue("3650");
      await page.locator("[data-testid='fleet-field-staleHostRetentionDays']").fill("0");
      await page.locator("[data-testid='fleet-save']").click();

      await expect.poll(() => bodies.length, { message: "turning the sweep off was blocked" }).toBe(1);
      expect(bodies[0]).toEqual({ staleHostRetentionDays: 0 });
      await expect(page.locator("[data-testid='fleet-sweep-confirm']")).toHaveCount(0);
    } finally {
      // Back to OFF whatever happened above: leaving a suite account armed would let a
      // later run delete rows nobody pointed at.
      await request.put("/api/fleet/settings", { data: { staleHostRetentionDays: 0 } });
      await request.dispose();
    }
  });
});
