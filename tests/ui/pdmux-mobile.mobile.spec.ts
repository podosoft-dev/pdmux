import { type Page, expect, test } from "@playwright/test";
import { expectOnScreen, expectViewportBound } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { e2eAdminState } from "../helpers/accounts";

/**
 * The dashboard on a phone.
 *
 * WHY A SEPARATE PROJECT: every existing spec runs at 1280x720, and the shell has a
 * completely different layout below 900px — one that nothing ever exercised. Measured on
 * a 390x844 viewport before this suite existed:
 *
 *   grid-template-rows: 320.7px 0px 523.3px   (the template declares TWO rows)
 *   [data-pdmux-grid]:  366x0                 (with four panes mounted)
 *   .pdmux-graph:       390x523               (the git dock ate the screen)
 *
 * So the terminals were not "small on mobile", they were **zero pixels tall** — and no
 * DOM assertion would have noticed, because every element was present and correct.
 * These specs assert measured geometry for that reason (ARCHITECTURE §7).
 */

/** The shell's grid, as the browser resolved it. */
async function shellGrid(page: Page): Promise<{ columns: string[]; rows: string[] }> {
  return page.evaluate(() => {
    const shell = document.querySelector(".pdmux-shell");
    const style = shell ? getComputedStyle(shell) : null;
    const split = (value: string | undefined): string[] =>
      (value ?? "").trim().length === 0 || value === "none" ? [] : (value as string).trim().split(/\s+/);
    return { columns: split(style?.gridTemplateColumns), rows: split(style?.gridTemplateRows) };
  });
}

/** Set the two shell attributes directly — a CSS probe, not a user action. */
async function forceShellState(page: Page, sidebar: string, dock: string): Promise<void> {
  await page.evaluate(
    ([side, dk]) => {
      const shell = document.querySelector(".pdmux-shell") as HTMLElement | null;
      if (!shell) return;
      shell.dataset.sidebar = side as string;
      shell.dataset.dock = dk as string;
    },
    [sidebar, dock],
  );
}

/** The boxes of the three switchable regions, in one pass. */
async function regionBoxes(page: Page): Promise<Record<string, { w: number; h: number }>> {
  return page.evaluate(() => {
    const read = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return { w: Math.round(rect?.width ?? 0), h: Math.round(rect?.height ?? 0) };
    };
    return {
      hosts: read("[data-pdmux-sidebar]"),
      terminal: read("[data-pdmux-region='terminal']"),
      git: read("[data-pdmux-region='dock']"),
    };
  });
}

// Its own account, host and agent (see `E2E_ADMIN`): these specs write the dashboard
// layout, and sharing an account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });


test.describe("pdmux on a phone", () => {
  test("[TC-PDUI-150] the terminals get a real column, not zero pixels", async ({ page }) => {
    await ready(page, "/");

    // The regression, exactly as measured: four panes mounted into a 366x0 box. A pane
    // that reports its own size as 0 has nothing to render into, so xterm draws nothing
    // and the screen looks like the dock is the whole app.
    const grid = page.locator("[data-pdmux-grid]");
    const box = await grid.boundingBox();
    expect(box, "the terminal grid is not in the layout at all").not.toBeNull();
    expect(box?.height ?? 0, "the terminal grid collapsed to zero height").toBeGreaterThan(200);

    // …and it is reachable, not merely sized: a box behind the dock would still measure.
    await expectOnScreen(grid, "terminal grid on a phone");
    await expectViewportBound(page);
  });

  test("[TC-PDUI-151] no shell state can bring the desktop grid back", async ({ page }) => {
    await ready(page, "/");

    // The second regression is a specificity inversion, not a missing rule: the mobile
    // block's selectors top out at (0,2,0) while
    // `.pdmux-shell[data-sidebar='hidden'][data-dock='open']` is (0,3,0), and @media adds
    // no specificity. Measured at 390px in that state the columns became
    // `0px 0px 0px 6px 420px` — a five-column desktop grid inside a 390px window, with a
    // 420px track for a dock that cannot fit. Both toggles are one tap away, so this is
    // reachable, not theoretical.
    for (const sidebar of ["open", "hidden"]) {
      for (const dock of ["open", "closed"]) {
        await forceShellState(page, sidebar, dock);
        const grid = await shellGrid(page);
        expect(
          grid.columns.length,
          `sidebar=${sidebar} dock=${dock} resolved to ${grid.columns.length} columns: ${grid.columns.join(" ")}`,
        ).toBe(1);
        // A phone stacks, so every row must be an explicit track. An implicit row is how
        // the dock claimed the screen and starved the terminals.
        expect(grid.rows.length, `sidebar=${sidebar} dock=${dock} rows: ${grid.rows.join(" ")}`).toBeLessThanOrEqual(3);
      }
    }
    await expectViewportBound(page);
  });

  test("[TC-PDUI-153] each tab gives its region the whole screen", async ({ page }) => {
    await ready(page, "/");
    const tabs = page.locator("[data-testid='shell-tabs']");
    await expect(tabs).toBeVisible();
    await expectOnScreen(tabs, "view tabs");

    for (const view of ["hosts", "terminal", "git"] as const) {
      await page.locator(`[data-testid='shell-tab-${view}']`).click();
      await expect(page.locator("[data-testid='dashboard-shell']")).toHaveAttribute("data-view", view);

      // Exactly one region is on screen. Three regions sharing a phone is the state that
      // left the terminals 0px tall; one region at a time is the whole point of the bar.
      const boxes = await regionBoxes(page);
      const shown = Object.entries(boxes).filter(([, box]) => box.h > 0);
      expect(shown.map(([name]) => name), `showing ${JSON.stringify(boxes)}`).toEqual([view]);

      // …and it gets the screen minus the bar, not a slice of it.
      const bar = await tabs.boundingBox();
      const shell = page.viewportSize();
      expect(boxes[view]?.h ?? 0).toBeGreaterThan((shell?.height ?? 0) - (bar?.height ?? 0) - 4);
      await expect(page.locator(`[data-testid='shell-tab-${view}']`)).toHaveAttribute("aria-current", "page");
      await expectViewportBound(page);
    }
  });

  test("[TC-PDUI-154] the back button returns to the previous tab", async ({ page }) => {
    await ready(page, "/");
    const shell = page.locator("[data-testid='dashboard-shell']");

    // A tab bar with no history entries makes Back leave the app — on Android that is the
    // system gesture, so it would throw away the page and every terminal on it.
    await page.locator("[data-testid='shell-tab-hosts']").click();
    await expect(shell).toHaveAttribute("data-view", "hosts");
    await page.locator("[data-testid='shell-tab-git']").click();
    await expect(shell).toHaveAttribute("data-view", "git");

    await page.goBack();
    await expect(shell).toHaveAttribute("data-view", "hosts");
    await page.goBack();
    await expect(shell).toHaveAttribute("data-view", "terminal");

    // Forward works too — the entries are real history, not a replay.
    await page.goForward();
    await expect(shell).toHaveAttribute("data-view", "hosts");
    await expectViewportBound(page);
  });

  test("[TC-PDUI-155] a route outside the dashboard owns the shell", async ({ page }) => {
    await ready(page, "/hosts");
    const shell = page.locator("[data-testid='dashboard-shell']");
    // `/hosts` renders no terminal and no dock, so its own panel is the view. Naming a
    // region the route did not render would show an empty screen.
    await expect(shell).toHaveAttribute("data-view", "page");
    await expect(page.locator("[data-testid='hosts-panel']")).toBeVisible();
    await expectOnScreen(page.locator("[data-testid='hosts-panel']"), "hosts panel on a phone");

    // The bar is still the way back to the dashboard.
    await page.locator("[data-testid='shell-tab-terminal']").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(shell).toHaveAttribute("data-view", "terminal");
    await expectViewportBound(page);
  });

  test("[TC-PDUI-157] the git tab stacks the repository panel and drops what does not fit", async ({ page }) => {
    await ready(page, "/");
    await page.locator("[data-testid='shell-tab-git']").click();
    await expect(page.locator("[data-testid='dashboard-shell']")).toHaveAttribute("data-view", "git");

    const refs = page.locator("[data-pdmux-refs]");
    const list = page.locator(".pdmux-graph-list");
    await expect(list).toBeVisible();
    // Beside the graph, the panel took a third of a 390px dock and left the graph 240px —
    // the width the container query itself calls unreadable. On a phone it goes ABOVE.
    if ((await refs.count()) > 0) {
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box ? { w: Math.round(box.width), bottom: Math.round(box.bottom), top: Math.round(box.top) } : null;
        };
        return { refs: rect("[data-pdmux-refs]"), list: rect(".pdmux-graph-list") };
      });
      expect(boxes.refs?.bottom ?? 0).toBeLessThanOrEqual((boxes.list?.top ?? 0) + 1);
      // Full width, not a column: `width: clamp(150px, 34%, 260px)` is a desktop rule and
      // silently won here until the override moved after it in the stylesheet.
      expect(boxes.refs?.w ?? 0).toBeGreaterThan((boxes.list?.w ?? 0) - 4);
    }

    // 110px author + 112px date + 60px sha + the lane gutter left the subject ~24px at
    // 390px — the one column a person reads. The author goes, the date shortens.
    const columns = await page.evaluate(() => {
      const author = document.querySelector(".pdmux-graph-author");
      const date = document.querySelector(".pdmux-graph-date");
      const subject = document.querySelector(".pdmux-graph-subject");
      return {
        author: author ? getComputedStyle(author).display : "absent",
        date: date ? Math.round(date.getBoundingClientRect().width) : 0,
        subject: subject ? Math.round(subject.getBoundingClientRect().width) : 0,
      };
    });
    expect(columns.author).toBe("none");
    expect(columns.date).toBeLessThanOrEqual(80);
    expect(columns.subject, "the subject is what a person reads").toBeGreaterThan(120);

    // REPORTED: the date wrapped inside a fixed-height row and covered the commit below it.
    // Narrowing a column is not enough — the TEXT has to fit, and the row has to clip.
    const rowFit = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".pdmux-graph-row")].slice(0, 12);
      return rows.map((row) => {
        const box = row.getBoundingClientRect();
        const cells = [...row.children].map((cell) => {
          const style = getComputedStyle(cell);
          return {
            wrap: style.whiteSpace,
            // A cell taller than one line is a wrapped cell.
            overflows: cell.scrollHeight > Math.ceil(box.height) + 1,
          };
        });
        return {
          clipped: getComputedStyle(row).overflow !== "visible",
          spills: row.scrollHeight > Math.ceil(box.height) + 1,
          wrapped: cells.some((cell) => cell.overflows),
        };
      });
    });
    expect(rowFit.length).toBeGreaterThan(0);
    expect(
      rowFit.filter((row) => row.spills || row.wrapped),
      "a commit row's content is taller than the row, so it covers the next commit",
    ).toEqual([]);
    expect(rowFit.every((row) => row.clipped), "the row must clip, as the last line of defence").toBe(true);

    // Tapping a commit opens its detail INSIDE the viewport, and the same row closes it.
    const rows = page.locator(".pdmux-graph-row");
    const detail = page.locator("[data-pdmux-detail]");
    if ((await rows.count()) > 1) {
      await rows.nth(1).click();
      await expect(detail).toBeVisible();
      await expectOnScreen(detail, "commit detail on a phone");
      await rows.nth(1).click();
      await expect(detail).toBeHidden();
    }

    // The detail's own row splitter must survive on a phone: the old blanket
    // `.pdmux-handle{display:none}` killed it along with the shell's column splitters, so
    // the panel's height was frozen with no way to change it.
    if ((await rows.count()) > 1) {
      await rows.nth(1).click();
      const handle = page.locator("[data-pdmux-handle][data-pdmux-axis='y']");
      await expect(handle).toBeVisible();
      expect(await handle.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBeGreaterThan(5);
      await rows.nth(1).click();
    }
    await expectViewportBound(page);
  });

  test("[TC-PDUI-174] the lane graph is drawn to the bottom of the list, not just the first screen", async ({ page }) => {
    /**
     * REPORTED ON A PHONE: scrolling the commit graph down drew no lanes and no dots at
     * all. The SVG is an absolute overlay whose height came from a hard-coded 24px row,
     * while `@media (pointer: coarse)` renders 40px rows — so it covered only about 60%
     * of the list, and drifted 16px per row above that, putting a dot beside the wrong
     * commit within three rows. The row height is now measured and fed to the geometry.
     */
    await ready(page, "/");
    await page.locator("[data-testid='shell-tab-git']").click();
    await expect(page.locator("[data-testid='dashboard-shell']")).toHaveAttribute("data-view", "git");
    const list = page.locator(".pdmux-graph-list");
    await expect(list).toBeVisible();
    const rowCount = await page.locator(".pdmux-graph-row").count();
    test.skip(rowCount < 3, "this stack has no collected commits to draw");

    // The symptom itself: go to the bottom.
    await list.evaluate((node) => node.scrollTo(0, node.scrollHeight));

    const probe = await page.evaluate(() => {
      const rows = document.querySelector<HTMLElement>(".pdmux-graph-rows");
      const svg = document.querySelector<SVGSVGElement>(".pdmux-graph-svg");
      const buttons = [...document.querySelectorAll<HTMLElement>(".pdmux-graph-row")];
      const centre = (node: Element): number => {
        const box = node.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      const dots = [...(svg?.querySelectorAll(".pdmux-dot") ?? [])];
      const first = buttons[0]!.getBoundingClientRect();
      const last = buttons[buttons.length - 1]!.getBoundingClientRect();
      return {
        rowHeight: Math.round(first.height),
        rowsHeight: Math.round(rows?.getBoundingClientRect().height ?? 0),
        svgHeight: Math.round(svg?.getBoundingClientRect().height ?? 0),
        rowCount: buttons.length,
        dotCount: dots.length,
        dotOnFirstRow: dots.some((dot) => centre(dot) >= first.top && centre(dot) <= first.bottom),
        dotOnLastRow: dots.some((dot) => centre(dot) >= last.top && centre(dot) <= last.bottom),
      };
    });

    // A touch device gets the taller row — if this is 24 the media query stopped applying
    // and the rest of the assertions would pass for the wrong reason.
    expect(probe.rowHeight, "a commit row is thumb-sized on a phone").toBe(40);
    // The overlay is exactly as tall as the stack it covers. Anything less is a stretch of
    // the list with no graph drawn in it, which is precisely what was reported.
    expect(Math.abs(probe.svgHeight - probe.rowsHeight)).toBeLessThanOrEqual(1);
    expect(probe.dotCount).toBe(probe.rowCount);
    expect(probe.dotOnLastRow, "the last commit has its dot").toBe(true);
    expect(probe.dotOnFirstRow, "the first commit has its dot").toBe(true);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-158] every control is thumb-sized and no input triggers a zoom", async ({ page }) => {
    await ready(page, "/");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "not emulating touch").toBe(true);

    // Measured before this rule: 18x20 and 22x20 icon buttons — under half the 44px a
    // fingertip hits reliably.
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".pdmux-ico, .pdmux-btn, .pdmux-chip, .pdmux-cog, .pdmux-tab, .pdmux-key")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({
          id: el.dataset.testid ?? el.getAttribute("aria-label") ?? el.className,
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        })),
    );
    // Count first: a selector that matches nothing would make the size assertion below
    // pass for the wrong reason, which is how a vacuous test hides a regression.
    expect(targets.length, "no controls were measured at all").toBeGreaterThan(3);
    expect(
      targets.filter((box) => Math.min(box.w, box.h) < 40),
      "controls smaller than a fingertip",
    ).toEqual([]);

    // iOS zooms the whole page when it focuses a control under 16px — and this page is a
    // 100dvh grid, so the zoom pushes the shell's bottom edge off screen. The one that
    // matters most is xterm's own hidden textarea, focused on every tap into a terminal.
    const tiny = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".pdmux input, .pdmux select, .pdmux textarea, .pdmux .xterm-helper-textarea")]
        .map((el) => ({ id: el.className, px: Math.round(parseFloat(getComputedStyle(el).fontSize)) }))
        .filter((box) => box.px < 16),
    );
    expect(tiny, "iOS will zoom the shell when one of these is focused").toEqual([]);
  });

  test("[TC-PDUI-159] a popover fits the screen it opens on", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await ready(page, "/");
    await page.locator("[data-testid='shell-tab-hosts']").click();

    // The clamp can only MOVE a popover, so a fixed 260/310px box hung off the right edge
    // of a 320px phone no matter where it was anchored.
    const cog = page.locator(".pdmux-cog").first();
    if ((await cog.count()) === 0) return;
    await cog.click();
    const popover = page.locator("[data-pdmux-popover='card-settings']");
    await expect(popover).toBeVisible();
    const fit = await page.evaluate(() => {
      const box = document.querySelector("[data-pdmux-popover]")?.getBoundingClientRect();
      return { left: Math.round(box?.left ?? -1), right: Math.round(box?.right ?? -1), w: window.innerWidth };
    });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right, "the popover hangs off the right edge").toBeLessThanOrEqual(fit.w);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-160] the host list keeps only the columns a phone can show", async ({ page }) => {
    await ready(page, "/hosts");
    const panel = page.locator("[data-testid='hosts-panel']");
    await expect(panel).toBeVisible();

    // Seven columns measured 611px inside a 390px screen: nothing was clipped (the table
    // scrolls) but the row menu was four columns away.
    const headers = await page.evaluate(() =>
      [...document.querySelectorAll("thead th")].filter((th) => th.getClientRects().length > 0).length,
    );
    expect(headers).toBeLessThanOrEqual(3);
    // Header and cell classes must agree, or the columns shift out of line.
    const cells = await page.evaluate(() => {
      const row = document.querySelector("tbody tr");
      return row ? [...row.children].filter((td) => td.getClientRects().length > 0).length : 0;
    });
    if (cells > 0) expect(cells).toBe(headers);
    await expectViewportBound(page);
  });

  test("[TC-PDUI-152] the narrowest supported phone still fits", async ({ page }) => {
    // 320px is the floor the product claims: a Galaxy S in a split view, an iPhone SE in
    // display-zoom. The fixed-width furniture (260/310px popovers, 282px of author/date/
    // sha columns in a commit row) breaks here first.
    await page.setViewportSize({ width: 320, height: 640 });
    await ready(page, "/");

    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement as Element;
      return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
    });
    expect(overflow.x, "the page scrolls sideways at 320px").toBeLessThanOrEqual(1);
    expect(overflow.y, "the page scrolls vertically — each column must scroll itself").toBeLessThanOrEqual(1);

    const grid = await shellGrid(page);
    expect(grid.columns.length).toBe(1);
    await expectViewportBound(page);
  });
});
