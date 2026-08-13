import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { expectOnScreen, expectScrollable, expectViewportBound } from "../helpers/geometry";
import { clickUntil, ready } from "../helpers/hydration";
import { openSidebar } from "../helpers/shell";
import { e2eAdminState } from "../helpers/accounts";
import { mockHost, mockUpdate, type MockHost } from "../helpers/fleet";

/**
 * The dashboard shell, measured rather than queried.
 *
 * The bug these tests exist for was never visible to a DOM assertion: the page grew
 * to its content height, the host list stopped being a scroll container and the
 * commit detail rendered thousands of pixels below a viewport that clips overflow.
 * Every `toBeVisible()` passed the whole time. So these checks ask where things are.
 */

const PREFIX = "e2e-dash-";

async function createHosts(request: APIRequestContext, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await request.post("/api/hosts", {
      data: { label: `${PREFIX}${Date.now()}-${index}`, address: "127.0.0.1" },
    });
    expect(response.ok(), "create host").toBeTruthy();
    ids.push(((await response.json()) as { id: string }).id);
  }
  return ids;
}

async function removeHosts(request: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) await request.delete(`/api/hosts/${id}`);
}

/** The first host/repo pair a collector has actually filled, or null. */
async function repoTarget(request: APIRequestContext): Promise<{ hostId: string; repoId: string } | null> {
  const hosts = (await (await request.get("/api/hosts")).json()) as { id: string }[];
  for (const host of hosts) {
    const repos = (await (await request.get(`/api/hosts/${host.id}/repos`)).json()) as { id: string }[];
    if (repos[0]) return { hostId: host.id, repoId: repos[0].id };
  }
  return null;
}

/**
 * Write the saved layout with `patch` applied, and with the refs-panel preference
 * removed so "the default" means the default.
 *
 * Both are one helper on purpose. Written as two, the width-only variant carried the
 * stored `dockRefsHidden: true` forward and the panel stayed hidden for a reason that
 * had nothing to do with the width being tested — the assertion then "passed" because
 * `toBeHidden()` is also true for an element that does not exist.
 */
async function putLayout(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  const response = await request.get("/api/prefs");
  if (!response.ok()) return;
  const prefs = (await response.json()) as {
    layouts?: { name: string; payload: Record<string, unknown>; isDefault?: boolean }[];
  };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  if (!layout) return;
  const payload = { ...layout.payload, dockOpen: true, ...patch };
  delete payload.dockRefsHidden;
  delete payload.dockRefs;
  await request.put(`/api/prefs/layouts/${encodeURIComponent(layout.name)}`, {
    data: { payload, isDefault: layout.isDefault ?? true },
  });
}

/**
 * The slots the SERVER has for this account, as JSON — i.e. what the next load reads.
 *
 * Asserted against rather than the rendered grid when the claim is about persistence:
 * a pane can disappear from the screen and still be in the saved layout, which is a
 * bug that only shows up on the next visit.
 */
async function storedSlots(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/prefs");
  if (!response.ok()) return "?";
  const prefs = (await response.json()) as {
    layouts?: { payload?: { slots?: unknown }; isDefault?: boolean }[];
  };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  return JSON.stringify(layout?.payload?.slots ?? []);
}

/**
 * The dock at its default width, with the panel preference cleared. The layout is
 * persisted per user, so a previous run — or a person clicking around — otherwise
 * decides what "by default" looks like.
 */
function resetDock(request: APIRequestContext): Promise<void> {
  // `dockDetailHeight` too: a drag test that starts from whatever height the PREVIOUS test
  // left behind measures a different gesture than the one it describes. That showed up as
  // an order-dependent flake — green alone, red in file order.
  return putLayout(request, { dockWidth: 420, dockDetailHeight: null });
}

// Its own account, host and agent (see `E2E_ADMIN`): these specs write the dashboard
// layout, and sharing an account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });


test.describe.serial("pdmux dashboard", () => {
  let created: string[] = [];

  test.beforeAll(async ({ playwright, baseURL }) => {
    // Enough cards that the sidebar has to scroll — with two hosts the check
    // could not tell a scroll container from a short list.
    const request = await playwright.request.newContext({
      baseURL,
      storageState: "playwright/.auth/admin.json",
    });
    created = await createHosts(request, 12);
    await request.dispose();
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({
      baseURL,
      storageState: "playwright/.auth/admin.json",
    });
    await removeHosts(request, created);
    await request.dispose();
  });

  test("[TC-PDUI-120] the shell fills the viewport and the page never scrolls", async ({ page }) => {
    await ready(page, "/");
    const shell = page.locator("[data-testid='dashboard-shell']");
    await expect(shell).toBeVisible();

    const facts = await shell.evaluate((el: HTMLElement) => ({
      height: Math.round(el.getBoundingClientRect().height),
      viewport: window.innerHeight,
    }));
    expect(Math.abs(facts.height - facts.viewport)).toBeLessThanOrEqual(1);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-121] the host column scrolls on its own", async ({ page }) => {
    await ready(page, "/");
    const sidebar = page.locator("[data-pdmux-sidebar]");
    await expect(sidebar.locator("[data-pdmux-host]").first()).toBeVisible();
    // The terminals own the rest of the viewport, so the cards cannot push the
    // page: the column is its own scroll container, with a gutter that shows it.
    await expectScrollable(sidebar, "host sidebar");
  });

  test("[TC-PDUI-122] the terminal grid stays inside the viewport in every split", async ({ page }) => {
    await ready(page, "/");
    for (const mode of ["split4", "split9", "tab"] as const) {
      await page.locator(`[data-testid='mode-${mode}']`).click();
      await expect(page.locator("[data-pdmux-grid]")).toHaveAttribute("data-pdmux-mode", mode);
      const cells = page.locator("[data-pdmux-cell]:not([hidden])");
      expect(await cells.count()).toBeGreaterThan(0);
      await expectOnScreen(cells.first(), `first cell in ${mode}`);
      await expectViewportBound(page);
    }
  });

  test("[TC-PDUI-123] dragging the splitter resizes the host column", async ({ page }) => {
    await ready(page, "/");
    const shell = page.locator("[data-testid='dashboard-shell']");
    const handle = page.locator(".pdmux-handle").first();
    const before = await shell.evaluate((el: HTMLElement) => el.style.getPropertyValue("--pdmux-left"));

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    // Pointer capture is what keeps a drag alive over a terminal surface, so the
    // gesture is driven as real pointer moves rather than a synthetic event.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => shell.evaluate((el: HTMLElement) => el.style.getPropertyValue("--pdmux-left")))
      .not.toBe(before);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-124] the layout survives a reload", async ({ page, request }) => {
    await ready(page, "/");
    await page.locator("[data-testid='mode-split9']").click();
    await expect(page.locator("[data-pdmux-grid]")).toHaveAttribute("data-pdmux-mode", "split9");

    /**
     * Wait for the SERVER to have it, not for a stopwatch.
     *
     * The write is debounced, and a fixed sleep raced it — reloading a beat early read the
     * previous row and the spec failed for a reason that has nothing to do with
     * persistence. Polling the same endpoint the next session reads is the actual claim.
     */
    const storedMode = async (): Promise<string | undefined> => {
      const response = await request.get("/api/prefs");
      if (!response.ok()) return undefined;
      const prefs = (await response.json()) as { layouts?: { payload?: { mode?: string }; isDefault?: boolean }[] };
      const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
      return layout?.payload?.mode;
    };
    await expect.poll(storedMode, { timeout: 10_000, message: "the layout never reached the server" }).toBe("split9");

    await ready(page, "/");
    await expect(page.locator("[data-pdmux-grid]")).toHaveAttribute("data-pdmux-mode", "split9");

    // Leave the split as the other specs expect to find it.
    await page.locator("[data-testid='mode-split4']").click();
    await expect.poll(storedMode, { timeout: 10_000 }).toBe("split4");
  });

  test("[TC-PDUI-126] a card's widget toggle is remembered per host", async ({ page }) => {
    await ready(page, "/");
    const card = page.locator("[data-pdmux-host]").first();
    const hostId = await card.getAttribute("data-pdmux-host");
    expect(hostId).toBeTruthy();
    await expect(card.locator("[data-pdmux-widget='resources']")).toBeVisible();

    await card.locator(".pdmux-cog").click();
    const popover = page.locator("[data-pdmux-popover='card-settings']");
    await expect(popover).toBeVisible();
    await popover.locator("[data-pdmux-toggle='resources']").click();
    await expect(card.locator("[data-pdmux-widget='resources']")).toHaveCount(0);

    // Written per host to the server, so another device (and this reload) agrees.
    await page.waitForTimeout(1500);
    await ready(page, "/");
    const same = page.locator(`[data-pdmux-host='${hostId}']`);
    await expect(same.locator("[data-pdmux-widget='resources']")).toHaveCount(0);

    // Restore, so the next run starts from the same screen.
    await same.locator(".pdmux-cog").click();
    await page.locator("[data-pdmux-popover='card-settings'] [data-pdmux-toggle='resources']").click();
    await expect(same.locator("[data-pdmux-widget='resources']")).toBeVisible();
    await page.waitForTimeout(1200);
  });

  test("[TC-PDUI-215] a folded card is remembered per host, and folding is not hiding", async ({ page }) => {
    await ready(page, "/");
    const card = page.locator("[data-pdmux-host]").first();
    const hostId = await card.getAttribute("data-pdmux-host");
    expect(hostId).toBeTruthy();
    const before = await card.locator("[data-pdmux-widget]").count();
    expect(before, "the fixture card shows nothing, so folding it would prove nothing").toBeGreaterThan(0);

    await card.locator("[data-pdmux-fold]").click();
    await expect(card).toHaveAttribute("data-pdmux-collapsed", "true");

    // Written per host to the server, so another device (and this reload) agrees. The
    // trap this guards is `sanitizeCardPrefs` dropping a key it does not know: the card
    // folds on screen, the row is written, and the reload quietly comes back open.
    await page.waitForTimeout(1500);
    await ready(page, "/");
    const same = page.locator(`[data-pdmux-host='${hostId}']`);
    await expect(same).toHaveAttribute("data-pdmux-collapsed", "true");

    // ⚠ THE WIDGETS ARE HIDDEN, NOT TURNED OFF. Unfolding has to bring back exactly what
    // was there — if the fold wrote through the widget switches, this count would drop.
    await same.locator("[data-pdmux-fold]").click();
    await expect(same).toHaveAttribute("data-pdmux-collapsed", "false");
    await expect(same.locator("[data-pdmux-widget]")).toHaveCount(before);
    await page.waitForTimeout(1200);
  });

  test("[TC-PDUI-136] the refs panel sits beside the graph and never lengthens the page", async ({
    page,
    request,
  }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    // The detached window is the wide case the panel was designed for, so it starts
    // open there; the dock's own toggle is TC-PDUI-137.
    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    const panel = page.locator("[data-pdmux-refs]");
    const list = page.locator(".pdmux-graph-list");
    await expect(panel).toBeVisible();
    await expectOnScreen(panel, "refs panel");

    const edges = await page.evaluate(() => {
      const refs = document.querySelector("[data-pdmux-refs]")?.getBoundingClientRect();
      const graph = document.querySelector(".pdmux-graph-list")?.getBoundingClientRect();
      return {
        refsRight: Math.round(refs?.right ?? -1),
        graphLeft: Math.round(graph?.left ?? -1),
        overflow: getComputedStyle(document.querySelector("[data-pdmux-refs]") as Element).overflowY,
      };
    });
    // Beside the graph, not above it and not over it.
    expect(edges.graphLeft).toBeGreaterThanOrEqual(edges.refsRight);
    // A repository with hundreds of tags must not lengthen the page: the panel scrolls.
    expect(edges.overflow).toBe("auto");
    await expect(list).toBeVisible();
    await expectViewportBound(page);

    // HEAD is stated, and every group heading carries its count.
    await expect(panel.locator("[data-pdmux-head-state]")).not.toBeEmpty();
    const headings = await panel.locator(".pdmux-refs-title").allTextContents();
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) expect(heading).toMatch(/\(\d+\)$/);

    // Collapsing is about the GRAPH's column, not the window. A narrow window actually
    // stacks the shell and makes the graph WIDER (measured: 380px window -> 380px graph),
    // so shrinking the viewport must not hide the panel.
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Dragged to the narrowest dock a person can choose, the column cannot seat both and
    // the graph wins.
    await putLayout(request, { dockWidth: 260 });
    await ready(page, "/");
    // Present but hidden — asserted in that order, because `toBeHidden()` alone is also
    // true for an element that was never rendered, which would pass for the wrong reason.
    await expect(page.locator("[data-pdmux-refs]")).toHaveCount(1);
    await expect(page.locator("[data-pdmux-refs]")).toBeHidden();
    await expectViewportBound(page);

    // Back to a normal width and it returns — nothing was unmounted, only hidden.
    await putLayout(request, { dockWidth: 420 });
    await ready(page, "/");
    await expect(page.locator("[data-pdmux-refs]")).toBeVisible();
  });

  test("[TC-PDUI-137] the dock remembers whether the refs panel is open", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    // Establish the starting state instead of assuming it. The layout is persisted per
    // user, so a previous run of this very test — or a person clicking around — leaves
    // the panel hidden, and then "it is visible by default" fails for a reason that has
    // nothing to do with the default.
    await resetDock(request);
    await ready(page, "/");
    // The dock column is always mounted (closing it narrows its grid tracks to zero
    // rather than unmounting it, so terminals never reconnect), so the shell attribute
    // is what says whether it is open — not the presence of the component.
    const shell = page.locator("[data-testid='dashboard-shell']");
    await expect(async () => {
      if ((await shell.getAttribute("data-dock")) !== "open") {
        await page.locator("[data-testid='toggle-dock']").click();
      }
      await expect(shell).toHaveAttribute("data-dock", "open", { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    const panel = page.locator("[data-pdmux-refs]");
    // Visible the moment the dock opens. It was behind a toggle that defaulted off,
    // which is why the person who asked for the panel kept reporting it missing: a
    // feature nobody can see without finding a switch has not been delivered.
    await expect(panel).toBeVisible();
    await expectOnScreen(panel, "refs panel in the dock");
    await expectViewportBound(page);

    // Hiding it is the deliberate act, and the choice is the user's, so it survives a
    // reload (debounced write).
    await page.locator("[data-testid='dock-refs']").click();
    await expect(panel).toHaveCount(0);
    await page.waitForTimeout(1500);
    await ready(page, "/");
    await expect(page.locator("[data-pdmux-refs]")).toHaveCount(0);

    // …and showing it again sticks too.
    await page.locator("[data-testid='dock-refs']").click();
    await expect(page.locator("[data-pdmux-refs]")).toBeVisible();

    // Restore the default (shown) and close the dock, so the next run — and the next
    // person to open this screen — starts where everyone else does.
    await page.locator("[data-testid='toggle-dock']").click();
    await page.waitForTimeout(1200);
  });

  test("[TC-PDUI-144] clicking the open commit row closes its detail", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    // The detail takes a share of a column that is not wide to begin with, so the row
    // that opened it has to close it — that is where a person reaches.
    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    const rows = page.locator(".pdmux-graph-row");
    await expect(rows.first()).toBeVisible();
    const row = rows.nth(1);
    // The panel stays mounted and hides itself, so `hidden` is the state to assert.
    const detail = page.locator("[data-pdmux-detail]");

    await row.click();
    await expect(detail).toBeVisible();
    await expectOnScreen(detail, "commit detail");

    await row.click();
    await expect(detail).toBeHidden();
    await expectViewportBound(page);

    // A third click opens it again — a toggle, not a one-way door.
    await row.click();
    await expect(detail).toBeVisible();
  });

  test("[TC-PDUI-175] the bottom-most commit stays visible when its detail opens", async ({
    page,
    request,
  }) => {
    /**
     * REPORTED: clicking one of the last rows opened the detail panel over the very row
     * that opened it. The list and the panel share one column, so opening the panel
     * SHRINKS the list — the row never moves, the floor rises past it.
     *
     * This runs against the real dock, not the geometry harness: the harness puts the
     * list directly in the column, while the dock nests it in `.pdmux-graph-body` beside
     * the refs panel and adds a splitter. The unit-level guard passed while the shipped
     * screen was still broken, so the shape that actually ships gets its own check.
     */
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    await expect(page.locator(".pdmux-graph-row").first()).toBeVisible();

    // Scroll to the end and take the last row that is actually on screen.
    const sha = await page.evaluate(() => {
      const list = document.querySelector(".pdmux-graph-list") as HTMLElement;
      list.scrollTo(0, list.scrollHeight);
      const bounds = list.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>(".pdmux-graph-row")];
      const onScreen = rows.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
      });
      return (onScreen[onScreen.length - 1] ?? rows[rows.length - 1])?.dataset.pdmuxSha ?? "";
    });
    expect(sha).not.toBe("");

    await page.locator(`.pdmux-graph-row[data-pdmux-sha="${sha}"]`).click();
    await expect(page.locator("[data-pdmux-detail]")).toBeVisible();
    // The panel opens over two layout passes and the correction is coalesced into one
    // animation frame after them, so "the detail is visible" does not mean the scroll has
    // landed. Poll — sampling once here passed only on retry.
    await expect
      .poll(async () =>
        page.evaluate((wanted) => {
          const list = document.querySelector(".pdmux-graph-list") as HTMLElement;
          const row = document.querySelector(`.pdmux-graph-row[data-pdmux-sha="${wanted}"]`) as HTMLElement;
          return Math.round(list.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
        }, sha),
      )
      .toBeGreaterThanOrEqual(-1);

    const placed = await page.evaluate((wanted) => {
      const list = document.querySelector(".pdmux-graph-list") as HTMLElement;
      const row = document.querySelector(`.pdmux-graph-row[data-pdmux-sha="${wanted}"]`) as HTMLElement;
      const bounds = list.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        current: row.getAttribute("aria-current"),
        below: bounds.bottom - box.bottom,
        above: box.top - bounds.top,
        reachable: Boolean(hit && (row === hit || row.contains(hit))),
      };
    }, sha);

    expect(placed.current).toBe("true");
    expect(placed.below, "the detail panel is covering the row that opened it").toBeGreaterThanOrEqual(-1);
    expect(placed.above).toBeGreaterThanOrEqual(-1);
    // Inside the list is not enough — it has to be the thing under that point.
    expect(placed.reachable).toBe(true);
  });

  test("[TC-PDUI-184] the host column spends one row on controls, not two", async ({ page }) => {
    /**
     * The column exists to hold cards; every pixel above the first one is overhead. The
     * controls had a row to themselves only because the product name occupied the row
     * above them — and the name is the one thing on this screen nobody needs telling,
     * since they are looking at it. Measured before and after: 66px of header became
     * 32px, and the first card moved from 78px down the column to 44px.
     *
     * Asserted as "one row" rather than against those numbers: a font or a token can move
     * them by a pixel without anything being wrong, but a second row is always a
     * regression of the thing this changed.
     */
    await ready(page, "/");
    await openSidebar(page);

    const probe = await page.evaluate(() => {
      const sidebar = document.querySelector("[data-pdmux-sidebar]") as HTMLElement;
      const header = sidebar.firstElementChild as HTMLElement;
      const add = document.querySelector("[data-testid='host-add-sidebar']") as HTMLElement | null;
      const hosts = document.querySelector("[data-testid='nav-hosts']") as HTMLElement | null;
      const box = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
      return {
        wordmark: Boolean(document.querySelector("[data-testid='dashboard-title']")),
        headerHeight: Math.round(box(header)!.height),
        control: add ? Math.round(box(add)!.height) : 0,
        // Same baseline = same row. Two rows would differ by a control's height.
        sameRow: add && hosts ? Math.abs(box(add)!.y - box(hosts)!.y) < 2 : false,
        // The controls start at the column's own padding, not indented behind something.
        addOffset: add ? Math.round(box(add)!.x - box(header)!.x) : -1,
      };
    });

    expect(probe.wordmark, "the wordmark is back, and it costs a row").toBe(false);
    expect(probe.control).toBeGreaterThan(0);
    // One row: the header is a control tall, give or take its own padding.
    expect(probe.headerHeight, "the column spends more than one row above the first card").toBeLessThanOrEqual(
      probe.control + 8,
    );
    expect(probe.sameRow, "add and hosts are on different rows").toBe(true);
    expect(probe.addOffset).toBeLessThanOrEqual(1);
  });

  test("[TC-PDUI-182] host management is reachable from the card it is about", async ({ page, request }) => {
    /**
     * The card already answers "how is this machine", and management is the follow-up to
     * that answer — so it has to be reachable from the card rather than by finding the
     * row again in a table.
     *
     * ⚠ REACHABLE IS NOT THE SAME AS PRESENT, and this test used to conflate them. The
     * panel had grown to six buttons and five reference rows; two of those buttons were
     * the same testid as buttons already on the host page, and three existed ONLY here —
     * so the page named after the host could not edit, disable or delete it. It is 260px
     * wide and capped at 70dvh: an entry point, not a container. One hop, and everything
     * it used to hold is on the page that hop leads to.
     */
    const target = await repoTarget(request);
    await ready(page, "/");
    await openSidebar(page);

    const card = page.locator("[data-pdmux-host]").first();
    await expect(card).toBeVisible();
    const openPopover = async () => {
      await card.locator(".pdmux-cog").click();
      await expect(page.locator("[data-pdmux-popover='card-settings']")).toBeVisible();
    };

    const label = (await card.locator("[data-pdmux-name]").textContent())?.trim() ?? "";
    await openPopover();

    // What the panel is for: the three switches, and the way out.
    await expect(page.locator("[data-pdmux-toggle]")).toHaveCount(3);
    await expect(page.locator("[data-testid='host-manage']")).toHaveAttribute("href", /\/hosts\//);

    // ⚠ And what it must NOT carry. These are the buttons that were duplicated or
    // stranded here; every one of them is asserted on the host page below.
    for (const gone of ["host-edit", "host-install", "host-toggle-enabled", "host-update", "host-remove"]) {
      await expect(page.locator(`[data-testid='${gone}']`), `${gone} is still on the card panel`).toHaveCount(0);
    }

    // One hop, and the host's own page carries all of it.
    await page.locator("[data-testid='host-manage']").click();
    await expect(page).toHaveURL(/\/hosts\/[0-9a-f-]+$/);
    for (const action of ["host-edit", "host-install", "host-toggle-enabled", "host-move-open", "host-remove"]) {
      await expect(page.locator(`[data-testid='${action}']`), `${action} is not on the host page`).toBeVisible();
    }

    // Edit opens the shared host form, already filled in for THIS host — a blank form
    // would mean it opened the "add" path by mistake.
    //
    // `clickUntil`, because the route was just reached by a client-side navigation and a
    // click inside the hydration window is swallowed with no error — this repository's
    // documented remedy, and the reason that helper exists.
    await clickUntil(page, "[data-testid='host-edit']", page.locator("[data-testid='host-form']"));
    await expect(page.locator("[data-testid='host-form']")).toBeVisible();
    await expect(page.locator("[data-testid='host-label'] input, input[data-testid='host-label']")).toHaveValue(label);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='host-form']")).toBeHidden();
    void target;
  });

  test("[TC-PDUI-149] the row whose detail is open looks different from every other row", async ({
    page,
    request,
  }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    const rows = page.locator(".pdmux-graph-row");
    await expect(rows.first()).toBeVisible();
    await rows.nth(1).click();
    await expect(page.locator("[data-pdmux-detail]")).toBeVisible();

    // Only one row claims the state, and it is the one that was clicked.
    await expect(page.locator(".pdmux-graph-row[aria-current='true']")).toHaveCount(1);
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");

    // THE BUG: selection painted the column's own background, which is also what hover
    // painted — so the row whose detail was open was indistinguishable from its
    // neighbours. Compared as computed colour, because "there is a rule for it" was
    // true the whole time it was invisible.
    const styles = await page.evaluate(() => {
      const read = (el: Element | null) => {
        const s = el ? getComputedStyle(el) : null;
        return { background: s?.backgroundColor ?? "", shadow: s?.boxShadow ?? "", weight: "" };
      };
      const selected = document.querySelector(".pdmux-graph-row[aria-current='true']");
      const other = document.querySelector(".pdmux-graph-row:not([aria-current='true'])");
      const subject = selected?.querySelector(".pdmux-graph-subject");
      const otherSubject = other?.querySelector(".pdmux-graph-subject");
      return {
        selected: read(selected),
        other: read(other),
        selectedWeight: subject ? getComputedStyle(subject).fontWeight : "",
        otherWeight: otherSubject ? getComputedStyle(otherSubject).fontWeight : "",
      };
    });
    expect(styles.selected.background).not.toBe(styles.other.background);
    // The band alone can wash out on a themed background, so the accent bar has to be
    // there too.
    expect(styles.selected.shadow).not.toBe("none");
    expect(styles.other.shadow).toBe("none");
    expect(Number(styles.selectedWeight)).toBeGreaterThan(Number(styles.otherWeight));

    // Picking another row moves the marker rather than accumulating it.
    await rows.nth(2).click();
    await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".pdmux-graph-row[aria-current='true']")).toHaveCount(1);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-147] the commit detail resizes by dragging its edge", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    const rows = page.locator(".pdmux-graph-row");
    await expect(rows.first()).toBeVisible();
    const detail = page.locator("[data-pdmux-detail]");
    const handle = page.locator("[data-pdmux-handle][data-pdmux-axis='y']");

    // No panel, no handle: a row splitter under an empty graph would resize something
    // the user cannot see.
    await expect(handle).toHaveCount(0);

    await rows.nth(1).click();
    await expect(detail).toBeVisible();
    await expect(handle).toBeVisible();

    const before = await detail.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // A real drag, through the pointer events the handle listens to. Dragging UP must
    // make the panel taller — it sits below the handle.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 8 });
    await page.mouse.up();

    await expect(async () => {
      const after = await detail.evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(after).toBeGreaterThan(before + 40);
    }).toPass({ timeout: 5000 });

    // The graph above it keeps a usable column and the page still does not scroll —
    // the whole point of capping the panel.
    const graph = page.locator(".pdmux-graph-list");
    await expect(graph).toBeVisible();
    expect(await graph.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBeGreaterThan(80);
    await expectViewportBound(page);
    await expectOnScreen(detail, "resized commit detail");
  });

  test("[TC-PDUI-148] a dock resize survives a reload", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    // In the dock the height is the user's saved layout — the detached window keeps its
    // own local proportions, which TC-PDUI-147 covers.
    await resetDock(request);
    await ready(page, "/");
    const shell = page.locator("[data-testid='dashboard-shell']");
    await expect(async () => {
      if ((await shell.getAttribute("data-dock")) !== "open") {
        await page.locator("[data-testid='toggle-dock']").click();
      }
      await expect(shell).toHaveAttribute("data-dock", "open", { timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    const rows = page.locator(".pdmux-graph-row");
    await expect(rows.first()).toBeVisible();
    await rows.nth(1).click();
    const detail = page.locator("[data-pdmux-detail]");
    await expect(detail).toBeVisible();

    const handle = page.locator("[data-pdmux-handle][data-pdmux-axis='y']");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 90, { steps: 6 });
    await page.mouse.up();

    const resized = await detail.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    // Wait out the debounced write, then come back to a fresh document.
    await page.waitForTimeout(1500);
    await ready(page, "/");
    await rows.nth(1).click();
    await expect(detail).toBeVisible();
    const restored = await detail.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(Math.abs(restored - resized)).toBeLessThanOrEqual(12);

    // Leave the stored layout as the other specs expect to find it.
    await putLayout(request, { dockWidth: 420, dockDetailHeight: null });
  });

  test("[TC-PDUI-143] a layout saved before the panel existed still shows it", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    // THE REGRESSION, at the level it actually bit: the first version stored
    // `dockRefs: false` by default, so every returning user carried an explicit "off"
    // and no change of default could ever reach them. The legacy key must be ignored.
    const saved = await request.get("/api/prefs");
    const prefs = (await saved.json()) as { layouts?: { name: string; payload: Record<string, unknown>; isDefault?: boolean }[] };
    const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
    test.skip(!layout, "no saved layout to migrate");
    if (!layout) return;

    const legacy = { ...layout.payload, dockOpen: true, dockRefs: false };
    delete (legacy as Record<string, unknown>).dockRefsHidden;
    const written = await request.put(`/api/prefs/layouts/${encodeURIComponent(layout.name)}`, {
      data: { payload: legacy, isDefault: true },
    });
    expect(written.ok(), `writing the legacy layout failed (${written.status()})`).toBe(true);

    await ready(page, "/");
    await expect(page.locator("[data-pdmux-refs]")).toBeVisible();
    await expectViewportBound(page);

    // Leave the stored layout in the shape the other specs expect, rather than clicking
    // a toggle whose debounced write may land after the next test has already loaded.
    await resetDock(request);
  });

  test("[TC-PDUI-145] collapsing the sidebar frees its column instead of hiding under the panes", async ({
    page,
  }) => {
    await ready(page, "/");
    const shell = page.locator("[data-testid='dashboard-shell']");
    const sidebar = page.locator("[data-pdmux-sidebar]");

    // Start from "open", whatever the stored layout says.
    await expect(async () => {
      if ((await shell.getAttribute("data-sidebar")) !== "open") {
        await page.locator("[data-testid='toggle-sidebar']").click();
      }
      await expect(shell).toHaveAttribute("data-sidebar", "open", { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(sidebar).toBeVisible();
    const openState = await page.evaluate(() => ({
      gridLeft: Math.round(document.querySelector("[data-pdmux-grid]")?.getBoundingClientRect().left ?? -1),
      sidebarWidth: Math.round(document.querySelector("[data-pdmux-sidebar]")?.getBoundingClientRect().width ?? -1),
    }));

    await page.locator("[data-testid='toggle-sidebar']").click();
    await expect(shell).toHaveAttribute("data-sidebar", "hidden");

    // THE BUG: the column was narrowed to 0 and the sidebar was left in the layout, so
    // the panes were drawn OVER it — the cards stayed hit-testable underneath and the
    // grid started at x>0. A zero-width grid track does not clip its content, which is
    // why "it is 0px wide" was never the same as "it is gone".
    await expect(sidebar).toBeHidden();
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector("[data-pdmux-grid]")?.getBoundingClientRect();
      const probeX = 24;
      const probeY = Math.round((grid?.top ?? 0) + (grid?.height ?? 0) / 2);
      const hit = document.elementFromPoint(probeX, probeY);
      return {
        gridLeft: Math.round(grid?.left ?? -1),
        gridWidth: Math.round(grid?.width ?? -1),
        overSidebar: Boolean(hit?.closest("[data-pdmux-sidebar]")),
        inGrid: Boolean(hit?.closest("[data-pdmux-grid]")),
      };
    });
    // The panes actually take the freed width: the grid's left edge moves left by about
    // the column that went away (a few px of shell padding is not the sidebar).
    expect(openState.gridLeft - geometry.gridLeft).toBeGreaterThanOrEqual(openState.sidebarWidth - 8);
    expect(geometry.overSidebar).toBe(false);
    expect(geometry.inGrid).toBe(true);
    // …and the panes still HAVE a column. The first attempt at this fix used
    // `display: none`, which dropped the sidebar out of the grid and let auto placement
    // slide every remaining child one track left: measured, the pane grid became 0px
    // wide and the git dock filled the window.
    expect(geometry.gridWidth).toBeGreaterThan(200);
    await expectViewportBound(page);

    // Reopening restores it — the collapse hides, it does not destroy.
    await page.locator("[data-testid='toggle-sidebar']").click();
    await expect(shell).toHaveAttribute("data-sidebar", "open");
    await expect(sidebar).toBeVisible();
  });

  test("[TC-PDUI-138] the signed-in user is an avatar in the sidebar's control row", async ({ page }) => {
    await ready(page, "/");
    const sidebar = page.locator("[data-pdmux-sidebar]");
    const trigger = page.locator("[data-testid='shell-user']");
    const theme = page.getByRole("button", { name: "Toggle theme" });
    await expect(trigger).toBeVisible();

    // The band it used to occupy is GONE, not merely emptied. That block cost ~52px of
    // a column whose whole job is to hold host cards, and reclaiming them is the point
    // of the change — a footer slot that still renders would give none of them back.
    await expect(page.locator("[data-pdmux-sidebar-foot]")).toHaveCount(0);

    // Top of the column and last in the control row: it shares the row the language and
    // theme switches already had, to the RIGHT of the theme toggle, and sits above the
    // first card rather than below the last one.
    const box = await page.evaluate(() => {
      const side = document.querySelector("[data-pdmux-sidebar]")?.getBoundingClientRect();
      const user = document.querySelector("[data-testid='shell-user']")?.getBoundingClientRect();
      const card = document.querySelector("[data-pdmux-sidebar] [data-pdmux-host]")?.getBoundingClientRect();
      return {
        sidebarTop: Math.round(side?.top ?? -1),
        sidebarRight: Math.round(side?.right ?? -1),
        userTop: Math.round(user?.top ?? -1),
        userRight: Math.round(user?.right ?? -1),
        cardTop: card ? Math.round(card.top) : null,
      };
    });
    // Within the column's own padding of the top — i.e. in the header row, not the list.
    expect(box.userTop - box.sidebarTop).toBeLessThanOrEqual(24);
    expect(box.userRight).toBeLessThanOrEqual(box.sidebarRight);
    if (box.cardTop !== null) expect(box.userTop).toBeLessThan(box.cardTop);
    const themeRight = await theme.evaluate((node) => Math.round(node.getBoundingClientRect().right));
    expect(box.userRight).toBeGreaterThan(themeRight);
    await expectOnScreen(trigger, "user menu trigger");
    await expectScrollable(sidebar, "host sidebar");
    await expectViewportBound(page);

    // The identity the trigger gave up has to be reachable, or the avatar answers
    // nothing: the menu opens downwards now and carries the name and the address.
    await expect(async () => {
      await trigger.click();
      await expect(page.locator("[data-testid='shell-user-account']")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expectOnScreen(page.locator("[data-testid='shell-user-identity']"), "identity block");
    await expectOnScreen(page.locator("[data-testid='shell-user-account']"), "account item");
    await expect(page.locator("[data-testid='shell-user-signout']")).toBeVisible();
    await page.keyboard.press("Escape");
    await expectViewportBound(page);
  });

  test("[TC-PDUI-125] clicking a commit shows its patch inside the viewport", async ({ page, request }) => {
    const target = await repoTarget(request);
    test.skip(!target, "no repository has been collected yet — run an agent with gitRoots configured");
    if (!target) return;

    await ready(page, `/git/${target.hostId}/${target.repoId}`);
    const rows = page.locator(".pdmux-graph-row");
    await expect(rows.first()).toBeVisible();

    // The list owns its scrolling and ends inside the viewport. Whether it has
    // enough rows to actually scroll depends on the repository in front of it, so
    // the stronger check runs only when the content really overflows — the fixed
    // 80-row fixture in `@pdmux/ui` covers the other case.
    const list = page.locator(".pdmux-graph-list");
    const facts = await list.evaluate((el: HTMLElement) => ({
      overflow: getComputedStyle(el).overflowY,
      bottom: Math.round(el.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      overflows: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(facts.overflow).toBe("auto");
    expect(facts.bottom).toBeLessThanOrEqual(facts.viewport + 1);
    if (facts.overflows) await expectScrollable(list, "commit list");

    // A commit row, not the working-tree row: the patch has to come from the
    // per-click fetch rather than from anything the list already carried.
    await rows.filter({ hasNot: page.locator(".pdmux-wip") }).nth(1).click();
    const detail = page.locator("[data-pdmux-detail]");
    await expect(detail).toBeVisible();
    await expect(detail.locator("[data-pdmux-subject]")).not.toBeEmpty();
    await expectOnScreen(detail, "commit detail");
    await expectViewportBound(page);
  });

  /**
   * The settings affordance on a card, measured as a target rather than queried.
   *
   * It was built as text — a 13px `⚙` in 2px of padding — and measured **16x17**: a
   * quarter of the area of the smallest button this app's own registry ships
   * (`size="icon"` is `size-8`), on a surface that is used from a phone. Nothing about
   * that was visible to a DOM assertion; the button existed, it was clickable, and
   * TC-PDUI-166 drove a host deletion through it the whole time.
   *
   * This is the FINE-pointer floor. `(pointer: coarse)` raises the same controls to
   * 44px and TC-PDUI-158 owns that half — the two are separate because width decides
   * layout and pointer decides size (ARCHITECTURE §7-1), so a desktop regression is
   * invisible to a phone test and vice versa.
   */
  test("[TC-PDUI-167] the card's settings trigger and its panel are sized to be hit", async ({ page }) => {
    await ready(page, "/");
    await openSidebar(page);

    const hostId = await page.locator("[data-pdmux-sidebar] [data-pdmux-host]").first().getAttribute("data-pdmux-host");
    expect(hostId, "no card to measure a trigger on").toBeTruthy();
    const cogSelector = `[data-pdmux-host='${hostId}'] .pdmux-cog`;
    const trigger = await page.locator(cogSelector).evaluate((el: HTMLElement) => ({
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
      head: Math.round((el.parentElement as HTMLElement).getBoundingClientRect().height),
      drawn: el.querySelector("svg") !== null,
    }));
    expect(Math.min(trigger.w, trigger.h), "the settings trigger is smaller than an icon button").toBeGreaterThanOrEqual(36);
    /*
     * …and the size costs the column nothing. The button is pulled into the card's own
     * padding, so the header it sits in is SHORTER than the button — the property that
     * lets a 36px target exist on a card whose text line is 23px without adding 13px of
     * height to every card in the fleet.
     */
    expect(trigger.head, "the bigger trigger grew the card header").toBeLessThan(trigger.h);
    // Drawn, not typed: `⚙` is an emoji-presentation codepoint, so the platform chose
    // the font and with it the weight and the size.
    expect(trigger.drawn, "the gear went back to being a text glyph").toBe(true);

    await clickUntil(page, cogSelector, page.locator("[data-pdmux-popover='card-settings']"));
    const panel = await page.evaluate(() => ({
      rows: [...document.querySelectorAll<HTMLElement>(".pdmux-toggle")].map((el) =>
        Math.round(el.getBoundingClientRect().height),
      ),
      switches: document.querySelectorAll(".pdmux-switch").length,
      // `button, a`: the panel's one remaining action is a LINK to the host's page —
      // the buttons that used to be here moved onto that page. A selector that only
      // matched `button` would report "no action rendered" for a panel that has one.
      actions: [...document.querySelectorAll<HTMLElement>("[data-pdmux-popover-acts] button, [data-pdmux-popover-acts] a")].map((el) =>
        Math.round(el.getBoundingClientRect().height),
      ),
    }));
    // Count first, and against the other half of the row: a selector that matched
    // nothing would make every size assertion below pass for the wrong reason.
    expect(panel.rows.length, "no preference rows were measured at all").toBeGreaterThan(0);
    expect(panel.switches, "a preference row lost its switch").toBe(panel.rows.length);
    expect(panel.rows.filter((h) => h < 32), "a preference row is thinner than a menu item").toEqual([]);
    // The app's slot. The package gives it the panel's rhythm and a floor; what it
    // renders in it is the app's own destructive button (TC-PDUI-166 drives it).
    expect(panel.actions.length, "the fleet action never rendered").toBeGreaterThan(0);
    expect(panel.actions.filter((h) => h < 32), "the destructive action is thinner than a button").toEqual([]);
    await expectViewportBound(page);
  });
});

/**
 * The card column's own two verbs.
 *
 * Both used to happen somewhere else, and that was the complaint. "Add" was a link to
 * `/hosts`, so registering a machine began by leaving the dashboard and pressing a
 * second Add on a table. "Remove" had no affordance at all: the only delete lived in
 * that table's row menu, a navigation and three clicks from the card that told you the
 * machine was gone. Both now happen in the sidebar, with the same dialogs `/hosts`
 * uses — one add path, one typing gate.
 */
test.describe.serial("pdmux shell fleet controls", () => {
  /** A marker written onto a live element; it survives only if the element does. */
  type Marked = HTMLElement & { __pdmuxMark?: number };
  const MARK = 165;
  const label = `${PREFIX}card-${Date.now().toString().slice(-6)}`;

  test.afterAll(async ({ playwright, baseURL }) => {
    // The e2e account's own state, not `admin.json`: fleet rows are scoped per account
    // (`personal:<userId>`), so cleaning up as a different user lists a different fleet
    // and deletes nothing. A green run has already removed this host in TC-PDUI-166;
    // this is for the run that failed half way.
    const request = await playwright.request.newContext({ baseURL, storageState: e2eAdminState });
    const hosts = (await (await request.get("/api/hosts")).json()) as { id: string; label: string }[];
    for (const host of hosts.filter((row) => row.label === label)) {
      await request.delete(`/api/hosts/${host.id}`);
    }
    await request.dispose();
  });

  test("[TC-PDUI-165] the card column registers a host without leaving the dashboard", async ({ page }) => {
    await ready(page, "/");
    await openSidebar(page);
    const shell = page.locator("[data-testid='dashboard-shell']");
    // Mark the live shell: "in place" is not "the URL happens to be the same" — a
    // navigation that re-mounted the group would lose this property and the terminals
    // with it.
    await shell.evaluate((el: Marked, mark: number) => (el.__pdmuxMark = mark), MARK);

    await clickUntil(page, "[data-testid='host-add-sidebar']", page.locator("[data-testid='host-label']"));
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.locator("[data-pdmux-grid]")).toBeVisible();

    await page.locator("[data-testid='host-label']").fill(label);
    await page.locator("[data-testid='host-address']").fill("10.9.9.9");
    await page.locator("[data-testid='host-save']").click();

    // A row is not a machine. The step that makes it one is a command on the box, and
    // the code for it arrives WITH the host — so adding from the sidebar has to end on
    // the same installer the host list hands over, not on a bare new card.
    const dialog = page.locator("[data-testid='enroll-dialog']");
    await expect(dialog).toBeVisible();
    await expect(page.locator("[data-testid='enroll-command']")).toContainText("/install.sh | sh -s -- --code pdmxe_");
    await expect(page.locator("[data-testid='enroll-code']")).toContainText("pdmxe_");
    await page.locator("[data-testid='enroll-close']").click();
    await expect(dialog).toHaveCount(0);

    // The card is in the column, and the shell around it was never re-created.
    await expect(page.locator("[data-pdmux-sidebar] [data-pdmux-name]").filter({ hasText: label })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    expect(await shell.evaluate((el: Marked) => el.__pdmuxMark ?? null)).toBe(MARK);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-166] removing a host from its card takes the card and any pane with it", async ({
    page,
    request,
  }) => {
    const hosts = (await (await request.get("/api/hosts")).json()) as { id: string; label: string }[];
    const hostId = hosts.find((row) => row.label === label)?.id;
    expect(hostId, "TC-PDUI-165 must have registered the host").toBeTruthy();
    if (!hostId) return;

    /**
     * Point a pane at it first, because that is the half a delete used to leave behind.
     * The API takes the host's tokens with it and closes the agent's socket, so a slot
     * that outlives its host sits in the grid claiming to be connected to a machine
     * this server will now refuse.
     */
    const original = await storedSlots(request);
    await putLayout(request, {
      slots: [{ id: "s1", hostId, kind: "shell", session: null }],
      zoomId: null,
      focusId: null,
    });

    await ready(page, "/");
    await openSidebar(page);
    const pane = page.locator(".pdmux-pane-label").filter({ hasText: label });
    await expect(pane).toBeVisible();

    /**
     * ⚠ THE DELETE MOVED OFF THE CARD, and this test still matters because the SHELL's
     * half of it did not. What is asserted below — the card goes, the pane pointed at it
     * goes, and the saved layout agrees — is the shell reacting to a host that stopped
     * existing, wherever the delete was pressed. It used to be pressed one row under a
     * display switch in a 260px panel; it is now on the host's own page behind the same
     * typing gate, and the shell has to notice just the same.
     */
    const card = page.locator(`[data-pdmux-host='${hostId}']`);
    await clickUntil(page, `[data-pdmux-host='${hostId}'] .pdmux-cog`, page.locator("[data-testid='host-manage']"));
    await page.locator("[data-testid='host-manage']").click();
    await expect(page).toHaveURL(new RegExp(`/hosts/${hostId}$`));
    await clickUntil(page, "[data-testid='host-remove']", page.locator("[data-testid='host-delete-input']"));

    // The typing gate the host list already uses: this cannot be undone and it takes
    // the tokens with it, so a second button would prove nothing about which card the
    // operator is looking at.
    const confirm = page.locator("[data-testid='host-delete-confirm']");
    await expect(confirm).toBeDisabled();
    await page.locator("[data-testid='host-delete-input']").fill(label);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Deleting from the host's own page leaves a route named after a row that is gone,
    // so it lands on the list.
    await expect(page).toHaveURL((url) => url.pathname === "/hosts");

    /**
     * ⚠ THE SAVE IS ASSERTED BEFORE ANY RELOAD, and the order is the point. Pruning the
     * layout goes through the shell's debounced writer (700ms), and a full page load
     * inside that window destroys the document holding the timer — so a reload here
     * would fail this every time while the product was working. The app's own
     * navigation is client-side and keeps the timer alive; only a test can lose it.
     */
    await expect
      .poll(() => storedSlots(request), { timeout: 10_000, message: "the pruned layout never reached the server" })
      .not.toContain(hostId);

    // Now the dashboard, which is where the half this test exists for is visible.
    await ready(page, "/");
    await openSidebar(page);

    // Gone from the column, with the shell still around it.
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-testid='dashboard-shell']")).toBeVisible();
    await expect(page.locator("[data-pdmux-grid]")).toBeVisible();

    // And nothing still claims that host: the cell is EMPTY rather than a pane whose
    // title has decayed to a dead uuid, and the saved layout agrees — the screen
    // telling the truth until the next reload would not be a fix.
    await expect(pane).toHaveCount(0);
    await expect(page.locator("[data-pdmux-cell='0'][data-pdmux-kind]")).toHaveCount(1);
    await expectViewportBound(page);

    // Leave the grid as the rest of the run expects to find it.
    await putLayout(request, { slots: JSON.parse(original) as unknown[] });
  });
});

/**
 * The sidebar's agent-update mark.
 *
 * ⚠ THE ASSERTION THE FEATURE EXISTS FOR IS THE NEGATIVE ONE IN 2. A badge wired
 * straight to the API would satisfy every other check here — it would appear on the
 * right hosts, it would update the right machine, and it would have skipped the
 * confirmation the user asked for. "No request has been made yet" is the only line
 * that notices.
 *
 * Fabricated rows rather than real hosts: the states are the point, and a real agent
 * on this machine cannot produce them. The sidebar reads the same `GET /hosts` the
 * table does, so mocking it drives the cards.
 */
/**
 * ⚠ THE COMMIT LIST HAS TO SURVIVE OPENING THE BRANCH PANEL, and only geometry can
 * say so. A remote-status panel was added beside the refs as a second flex child of
 * `.pdmux-graph-body`, which lays its children out in a ROW — the refs took 150px,
 * the new panel sized itself to its own text at 313px, and the commit list was
 * squeezed from 420px to ZERO. Every spec stayed green: the list was still in the
 * DOM, still "visible", and nobody could see a single commit.
 *
 * `.pdmux-refs` carries the rule in a comment — "never more than a third of a dock
 * column — the graph is what the user came for" — and a sibling was how to walk past
 * it. This asserts the outcome that comment protects.
 */
test("[TC-PDUI-203] the commit list keeps its width when the branch panel opens", async ({ page }) => {
  // ⚠ THE DATA IS FABRICATED, and it has to be. The first version of this guard
  // leaned on whatever the live agent had collected — so it failed against the
  // FIXED code the moment that host had no repositories, which is a guard that
  // reports on the fixture rather than on the layout.
  const repo = {
    id: "11111111-1111-4111-8111-111111111111",
    hostId: "h1",
    path: "/work/repo",
    name: "repo",
    headBranch: "main",
    headSha: "aaaaaaa",
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: new Date().toISOString(),
    error: null,
    remoteRefs: null,
    remoteCheckedAt: null,
    remoteError: null,
  };
  await page.route("**/api/hosts/*/repos", (route) => route.fulfill({ json: [repo] }));
  await page.route("**/api/hosts/*/repos/*", (route) =>
    route.fulfill({
      json: {
        repo,
        // A long branch name is the case the width rule was written for.
        refs: [{ name: "main", sha: "aaaaaaa", kind: "local" }, { name: "origin/release/2026-07-25", sha: "aaaaaaa", kind: "remote" }],
        commits: Array.from({ length: 12 }, (_, i) => ({
          sha: `${i}`.repeat(7),
          parents: [],
          refs: i === 0 ? ["main"] : [],
          author: "tester",
          date: 1_784_000_000 - i * 60,
          subject: `commit ${i}`,
          seq: i,
        })),
      },
    }),
  );

  await page.goto("/");
  await page.waitForSelector("[data-testid='commit-dock']");
  await page.waitForSelector(".pdmux-graph-list");

  const width = async (selector: string): Promise<number> =>
    page.evaluate((s) => {
      const element = document.querySelector(s);
      return element ? Math.round(element.getBoundingClientRect().width) : 0;
    }, selector);

  // ⚠ ONE STATE, NOT A BEFORE AND AFTER. The toggle is persisted in the saved layout
  // and round-trips through `/prefs`, so driving it twice races the save — the
  // "closed" reading never arrived and the guard timed out against correct code.
  // The rule being defended holds in the OPEN state on its own, so that is what is
  // measured.
  const toggle = page.locator("[data-testid='dock-refs']");
  const column = page.locator(".pdmux-refs-column");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await column.waitFor({ state: "visible" });

  const refs = await width(".pdmux-refs-column");
  const list = await width(".pdmux-graph-list");
  const body = await width(".pdmux-graph-body");

  expect(refs, "the branch panel did not open").toBeGreaterThan(0);
  // `.pdmux-refs` is `clamp(150px, 34%, 260px)`, so 260 is the documented ceiling for
  // everything on that side — the floor of 150 is why "a third" is the wrong number to
  // assert on a narrow dock. The shipped bug put a 313px sibling there.
  expect(refs, "the branch side outgrew its documented width").toBeLessThanOrEqual(260);
  // And the list keeps what is left. Zero is what shipped.
  expect(list, "the commit list was squeezed out by the branch panel").toBeGreaterThan(0);
  expect(refs + list, "something else is eating the dock").toBeLessThanOrEqual(body + 2);
});

/**
 * The three guards below share one fabricated repository and one fabricated commit
 * detail, so they measure the layout rather than whatever an agent last collected.
 */
async function withFabricatedCommit(page: Page): Promise<void> {
  const repo = {
    id: "22222222-2222-4222-8222-222222222222",
    hostId: "h1",
    path: "/work/repo",
    name: "repo",
    headBranch: "main",
    headSha: "aaaaaaa",
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: new Date().toISOString(),
    error: null,
    remoteRefs: null,
    remoteCheckedAt: null,
    remoteError: null,
  };
  await page.route("**/api/hosts/*/repos", (route) => route.fulfill({ json: [repo] }));
  await page.route("**/api/hosts/*/repos/*/commits/*/detail", (route) =>
    route.fulfill({
      json: {
        available: true,
        pending: 0,
        detail: {
          // ⚠ LONG ENOUGH TO OUTGROW THE PANEL, on purpose. A short patch and a short
          // message are the same height, and then a height guard proves nothing.
          body: "why it was done\n".repeat(3),
          bodyTruncated: false,
          authorEmail: "tester@example.com",
          truncated: false,
          dropped: 0,
          files: [
            { path: "src/deep/a.ts", status: "M", add: 3, del: 1, binary: false, truncated: false,
              lines: ["@@ -1,2 +1,4 @@", ...Array.from({ length: 40 }, (_, i) => `+first ${i}`)] },
            { path: "src/deep/b.ts", status: "A", add: 2, del: 0, binary: false, truncated: false,
              lines: ["@@ -0,0 +1,2 @@", "+second"] },
          ],
        },
      },
    }),
  );
  await page.route("**/api/hosts/*/repos/*", (route) => {
    if (/\/detail$/.test(route.request().url())) return route.fallback();
    return route.fulfill({
      json: {
        repo,
        refs: [{ name: "main", sha: "aaaaaaa", kind: "local" }],
        commits: Array.from({ length: 12 }, (_, i) => ({
          sha: `${i}`.repeat(7),
          parents: [],
          refs: i === 0 ? ["main"] : [],
          author: "tester",
          date: 1_784_000_000 - i * 60,
          subject: `commit ${i}`,
          seq: i,
        })),
      },
    });
  });
  await page.goto("/");
  await page.waitForSelector("[data-testid='commit-dock']");
  await page.locator(".pdmux-graph-row").first().click();
  await page.waitForSelector("[data-pdmux-file-row]");
}

/**
 * ⚠ THE PANEL IS ONE HEIGHT UNTIL THE USER DRAGS IT.
 *
 * It used to be content-height, so the message face (a few lines) and the patch face
 * (hundreds) gave the panel two different sizes — and every tab press resized it, and
 * therefore resized the commit list above it. Reported as "each tab change changes
 * the size". The 45% reservation existed but only while the patch was in flight
 * (`[data-pdmux-awaiting]`), which is the one moment this case is not in.
 */
test("[TC-PDUI-204] the detail panel keeps its height across tab changes", async ({ page }) => {
  await withFabricatedCommit(page);

  const panelHeight = async (): Promise<number> =>
    page.evaluate(() => {
      const element = document.querySelector("[data-pdmux-detail]");
      return element ? Math.round(element.getBoundingClientRect().height) : 0;
    });

  const onChanges = await panelHeight();
  expect(onChanges, "the panel did not open").toBeGreaterThan(0);

  await page.locator("[data-testid='detail-tab-commit']").click();
  await expect(page.locator("[data-pdmux-tabpanel='commit']")).toBeVisible();
  const onCommit = await panelHeight();

  await page.locator("[data-testid='detail-tab-changes']").click();
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toBeVisible();
  const back = await panelHeight();

  // Not "roughly": the panel is sized by the column, so the number is the same number.
  expect(onCommit, "the message face resized the panel").toBe(onChanges);
  expect(back, "coming back resized it again").toBe(onChanges);
});

/**
 * ⚠ A FILE LIST YOU CANNOT OPEN IS THE BUG. Fork shows a file's diff when you click
 * it; this shipped drawing paths and nothing else, and that is exactly what was
 * reported. The pair is the guard: nothing until a file is chosen, that file after.
 */
test("[TC-PDUI-205] clicking a file shows that file’s diff", async ({ page }) => {
  await withFabricatedCommit(page);

  await expect(page.locator("[data-pdmux-file-row='src/deep/a.ts']")).toBeVisible();
  expect(await page.locator("[data-pdmux-file-patch]").count(), "a patch was open before anything was clicked").toBe(0);

  await page.locator("[data-pdmux-file-row='src/deep/a.ts']").click();
  await expect(page.locator("[data-pdmux-file-patch='src/deep/a.ts']")).toBeVisible();
  await expect(page.locator("[data-pdmux-file-row='src/deep/a.ts']")).toHaveAttribute("aria-current", "true");
  // Only the chosen one — every patch at once is the screen this replaced.
  expect(await page.locator("[data-pdmux-file-patch]").count()).toBe(1);

  // Clicking the open row again closes it — Fork's toggle, and the same gesture the
  // commit rows in the graph already use.
  await page.locator("[data-pdmux-file-row='src/deep/a.ts']").click();
  expect(await page.locator("[data-pdmux-file-patch]").count()).toBe(0);

  // ⚠ THE `commit` FACE IS STACKED AT ANY WIDTH, so the same click works there and
  // the patch is under the row rather than beside it. Fork draws it that way, and
  // two faces that look identical when the window is wide would make the tabs
  // pointless.
  await page.locator("[data-testid='detail-tab-commit']").click();
  await expect(page.locator("[data-pdmux-tabpanel='commit']")).toBeVisible();
  await page.locator("[data-pdmux-file-row='src/deep/a.ts']").click();
  await expect(page.locator("[data-pdmux-file-patch='src/deep/a.ts']")).toBeVisible();
  expect(
    await page.locator("[data-pdmux-tabpanel='commit'] [data-pdmux-filepane='stacked']").count(),
    "the commit face split into two columns",
  ).toBe(1);
});

/**
 * ⚠ THE `File tree` FACE IS THE WHOLE REPOSITORY, NOT THE COMMIT'S CHANGES, and a
 * file there shows its CONTENTS rather than a patch. Conflating the two is exactly
 * the mistake this face was rebuilt to undo.
 *
 * ⚠ AND IT IS FETCHED LAZILY. The listing arrives when the TAB is opened and a file
 * when its ROW is clicked — never with the graph. The counters below are the guard:
 * an earlier build read the dock's own state inside the effect that triggers the
 * fetch, so the effect re-ran on every flip it caused and the browser asked for one
 * commit's listing 1,723 times in fifteen minutes, each one a frame to somebody's
 * machine. Measured on the live stack.
 */
test("[TC-PDUI-207] fetches a commit’s file listing only when that face is opened", async ({ page }) => {
  const repo = {
    id: "33333333-3333-4333-8333-333333333333",
    hostId: "h1",
    path: "/work/repo",
    name: "repo",
    headBranch: "main",
    headSha: "aaaaaaa",
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: new Date().toISOString(),
    error: null,
    remoteRefs: null,
    remoteCheckedAt: null,
    remoteError: null,
  };
  let treeCalls = 0;
  let blobCalls = 0;

  await page.route("**/api/hosts/*/repos", (route) => route.fulfill({ json: [repo] }));
  await page.route("**/api/hosts/*/repos/*/commits/*/detail", (route) =>
    route.fulfill({
      json: {
        available: true,
        pending: 0,
        detail: { body: "", bodyTruncated: false, truncated: false, dropped: 0, files: [] },
      },
    }),
  );
  await page.route("**/api/hosts/*/repos/*/commits/*/tree", (route) => {
    treeCalls += 1;
    return route.fulfill({
      json: {
        available: true,
        pending: 0,
        detail: {
          sha: "0000000",
          dropped: 0,
          truncated: false,
          error: null,
          entries: [
            { path: "src/deep/a.ts", size: 12 },
            { path: "README.md", size: 2048 },
          ],
        },
      },
    });
  });
  await page.route("**/api/hosts/*/repos/*/commits/*/blob**", (route) => {
    blobCalls += 1;
    return route.fulfill({
      json: {
        available: true,
        pending: 0,
        detail: {
          sha: "0000000",
          path: "README.md",
          lines: ["# pdmux", "", "a dashboard"],
          binary: false,
          truncated: false,
          bytes: 24,
          error: null,
        },
      },
    });
  });
  await page.route("**/api/hosts/*/repos/*", (route) => {
    if (/\/(detail|tree|blob)/.test(route.request().url())) return route.fallback();
    return route.fulfill({
      json: {
        repo,
        refs: [{ name: "main", sha: "aaaaaaa", kind: "local" }],
        commits: Array.from({ length: 6 }, (_, i) => ({
          sha: `${i}`.repeat(7),
          parents: [],
          refs: i === 0 ? ["main"] : [],
          author: "tester",
          date: 1_784_000_000 - i * 60,
          subject: `commit ${i}`,
          seq: i,
        })),
      },
    });
  });

  await page.goto("/");
  await page.waitForSelector("[data-testid='commit-dock']");
  await page.locator(".pdmux-graph-row").first().click();
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toBeVisible();

  // ⚠ NOTHING YET. Opening a commit must not cost a repository listing.
  expect(treeCalls, "the listing was fetched before its face was opened").toBe(0);

  await page.locator("[data-testid='detail-tab-tree']").click();
  await expect(page.locator("[data-pdmux-file-row='README.md']")).toBeVisible();
  expect(treeCalls).toBe(1);
  // And the files under it are still untouched.
  expect(blobCalls, "a file was read before it was clicked").toBe(0);

  // A directory is a disclosure, not a selection: it has no selectable row at all.
  await expect(page.locator("[data-pdmux-tree-toggle='src/deep']")).toBeVisible();
  await expect(page.locator("[data-pdmux-file-row='src/deep']")).toHaveCount(0);

  await page.locator("[data-pdmux-file-row='README.md']").click();
  await expect(page.locator("[data-pdmux-blob='README.md']")).toContainText("a dashboard");
  expect(blobCalls).toBe(1);

  // ⚠ AND LEAVING THE FACE AND COMING BACK ASKS FOR NEITHER AGAIN — the cache
  // answers. This is the counter that caught the request loop.
  await page.locator("[data-testid='detail-tab-changes']").click();
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toBeVisible();
  await page.locator("[data-testid='detail-tab-tree']").click();
  await expect(page.locator("[data-pdmux-file-row='README.md']")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(treeCalls, "re-entering the face re-fetched the listing").toBe(1);
});

/**
 * ⚠ THE ONE THAT ACTUALLY LOOPED. While the answer keeps arriving, everything stops
 * on its own; the runaway was the case where it never arrives — an agent too old to
 * know the frame logs it and keeps its socket, so the server answers "asked, still
 * waiting" forever. The effect that starts the fetch read the dock's own state, so
 * every flip it caused re-ran it, and giving up re-ran it again: 1,723 requests in
 * fifteen minutes on the live stack, each one a frame to somebody's machine.
 *
 * So the assertion is a CEILING on requests and a sentence on screen, not a success.
 */
test("[TC-PDUI-207] gives up on an unanswerable listing instead of asking forever", async ({ page }) => {
  const repo = {
    id: "44444444-4444-4444-8444-444444444444",
    hostId: "h1",
    path: "/work/repo",
    name: "repo",
    headBranch: "main",
    headSha: "aaaaaaa",
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtySubmodules: 0,
    truncated: false,
    limit: 300,
    pendingDetails: 0,
    hasWorkingDiff: false,
    lastSnapshotAt: new Date().toISOString(),
    error: null,
    remoteRefs: null,
    remoteCheckedAt: null,
    remoteError: null,
  };
  let treeCalls = 0;

  await page.route("**/api/hosts/*/repos", (route) => route.fulfill({ json: [repo] }));
  await page.route("**/api/hosts/*/repos/*/commits/*/detail", (route) =>
    route.fulfill({
      json: {
        available: true,
        pending: 0,
        detail: { body: "", bodyTruncated: false, truncated: false, dropped: 0, files: [] },
      },
    }),
  );
  // "I asked the agent; nothing yet" — for ever, which is what an agent too old does.
  await page.route("**/api/hosts/*/repos/*/commits/*/tree", (route) => {
    treeCalls += 1;
    return route.fulfill({ json: { available: false, pending: 1, detail: null } });
  });
  await page.route("**/api/hosts/*/repos/*", (route) => {
    if (/\/(detail|tree|blob)/.test(route.request().url())) return route.fallback();
    return route.fulfill({
      json: {
        repo,
        refs: [{ name: "main", sha: "aaaaaaa", kind: "local" }],
        commits: Array.from({ length: 6 }, (_, i) => ({
          sha: `${i}`.repeat(7),
          parents: [],
          refs: i === 0 ? ["main"] : [],
          author: "tester",
          date: 1_784_000_000 - i * 60,
          subject: `commit ${i}`,
          seq: i,
        })),
      },
    });
  });

  await page.goto("/");
  await page.waitForSelector("[data-testid='commit-dock']");
  await page.locator(".pdmux-graph-row").first().click();
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toBeVisible();
  await page.locator("[data-testid='detail-tab-tree']").click();

  // It says so rather than spinning: that sentence IS the end state.
  await expect(page.locator("[data-pdmux-tree-state='unavailable']")).toBeVisible({ timeout: 20_000 });
  const afterGivingUp = treeCalls;
  // The budget is 8 attempts. A handful more would be a slow poll; a hundred is the bug.
  expect(afterGivingUp, "the client polled past its budget").toBeLessThanOrEqual(12);

  // ⚠ AND IT STAYS GIVEN UP. This is the half that ran away: the state change that
  // ended the wait used to re-enter the effect and start the whole budget again.
  await page.waitForTimeout(6000);
  expect(treeCalls, "asking resumed after it had given up").toBe(afterGivingUp);
});

/**
 * ⚠ THE BOTTOM TAB BAR BELONGS TO PHONES. It picks one region at a time on a screen
 * too narrow for three, and the desktop block hides it —
 * `.pdmux-shell > [data-pdmux-region='tabs'] { display: none }`.
 *
 * A `.pdmux .pdmux-tabs` rule added for the commit detail tied that selector on
 * specificity (0,2,0) and sat later in the file, so it won and the bar appeared
 * across every desktop screen. Nothing near the git dock changed; the report came
 * from the other side of the app. A global stylesheet's name collisions are only
 * caught like this.
 */
test("[TC-PDUI-206] the phone tab bar is not drawn at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='commit-dock']");

  const bar = page.locator("[data-testid='shell-tabs']");
  await expect(bar).toBeHidden();

  // And it is still there for the phone — hidden at this width, not deleted.
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(bar).toBeVisible();
});

test.describe("agent updates on the sidebar", () => {
  const OUTDATED = mockHost("mock-behind", { agentVersion: "1.4.0", agentVersionState: "outdated" });
  const CURRENT = mockHost("mock-newest", { agentVersion: "1.5.0", agentVersionState: "current" });

  /**
   * ⚠ THE BODY IS RECORDED, NOT ONLY THE URL. The version travels in the body, so a
   * request that named no version at all was indistinguishable from one that pinned
   * the version the popover had just shown — and the unpinned one lets the server
   * resolve whatever is newest when it lands.
   */
  async function withHosts(page: Page, hosts: MockHost[]): Promise<{ updates: { url: string; body: unknown }[] }> {
    const updates: { url: string; body: unknown }[] = [];
    await page.route("**/api/hosts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: hosts });
    });
    await page.route("**/api/hosts/*/agent/update", async (route) => {
      updates.push({ url: route.request().url(), body: route.request().postDataJSON() as unknown });
      await route.fulfill({ json: { commandId: "c1", hostId: "h", version: "1.5.0" } });
    });
    return { updates };
  }

  test("[TC-PDUI-202] marks only the hosts that have somewhere to go", async ({ page }) => {
    await withHosts(page, [OUTDATED, CURRENT]);
    await page.goto("/");

    await expect(page.locator(`[data-pdmux-host="${OUTDATED.id}"] [data-pdmux-update]`)).toHaveAttribute(
      "data-pdmux-update",
      "offer",
    );
    // Nothing newer exists, so there is nothing to say — and a row that rendered
    // anyway would be the deleted busy/idle chip returning.
    await expect(page.locator(`[data-pdmux-host="${CURRENT.id}"] [data-pdmux-update]`)).toHaveCount(0);
  });

  test("[TC-PDUI-202] confirms before it acts", async ({ page }) => {
    const { updates } = await withHosts(page, [OUTDATED]);
    await page.goto("/");

    await page.locator(`[data-pdmux-host="${OUTDATED.id}"] [data-pdmux-update]`).click();

    const popover = page.getByTestId("agent-update-popover");
    await expect(popover).toBeVisible();
    // ⚠ THE LINE THAT PROVES THE FEATURE. Pressing the mark opened a question; it did
    // not start an update.
    expect(updates, "opening the popover must not have started an update").toHaveLength(0);

    // What it goes to, and the reassurance that the agent restores itself if the new
    // binary cannot connect — the thing somebody needs before pressing an
    // irreversible-looking button.
    await expect(popover).toContainText("1.5.0");
    await expect(popover.getByTestId("agent-update-probation")).toBeVisible();

    await popover.getByTestId("agent-update-confirm").click();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0]?.url).toContain(OUTDATED.id as string);
    // ⚠ AND IT NAMES THE VERSION THAT WAS ON SCREEN. Without it the server picks the
    // newest at the moment the request lands, so a release published while the popover
    // was open ships a binary the person never saw.
    expect(updates[0]?.body).toMatchObject({ version: OUTDATED.latestAgentVersion as string });
  });

  test("[TC-PDUI-202] reports a job in flight without offering a second one", async ({ page }) => {
    const busy = mockHost("mock-busy", {
      agentVersionState: "outdated",
      lastUpdate: mockUpdate(0, 0, { phase: "restarting", targetVersion: "1.5.0" }),
    });
    await withHosts(page, [busy]);
    await page.goto("/");

    const mark = page.locator(`[data-pdmux-host="${busy.id}"] [data-pdmux-update]`);
    await expect(mark).toHaveAttribute("data-pdmux-update", "busy");
    // Not a disabled button — not a button at all, so a second POST is structurally
    // impossible rather than merely discouraged.
    await expect(page.locator(`[data-pdmux-host="${busy.id}"] button[data-pdmux-update]`)).toHaveCount(0);
  });
});
