import { type Page, expect, test } from "@playwright/test";
import { expectOnScreen, expectViewportBound } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { openSidebar } from "../helpers/shell";
import { e2eAdminState } from "../helpers/accounts";

/**
 * The terminal panel end to end: browser -> SvelteKit origin -> relay -> agent PTY.
 *
 * It needs a host with a live agent, which is the point — a terminal that works
 * against a mock proves nothing about the path that actually carries bytes. Without
 * one the spec skips loudly rather than pretending to pass.
 */

interface HostRow {
  id: string;
  label: string;
  online: boolean;
  enabled: boolean;
  sessions: { name: string }[];
}

async function onlineHost(request: import("@playwright/test").APIRequestContext): Promise<HostRow | null> {
  const response = await request.get("/api/hosts");
  if (!response.ok()) return null;
  const hosts = (await response.json()) as HostRow[];
  return hosts.find((host) => host.online && host.enabled) ?? null;
}

/**
 * Does the terminal show this text?
 *
 * Whitespace is stripped from both sides of the comparison because a terminal wraps:
 * measured, `pdmux-keep-32826` rendered as `pdmux-keep-32` + `826` on two rows, and
 * `innerText` puts a newline between rows — so a plain `includes()` reported "the shell
 * never echoed it" while the echo was plainly on screen. Markers carry no spaces, so
 * stripping cannot create a false match.
 */
async function terminalShows(surface: ReturnType<Page["locator"]>, text: string): Promise<boolean> {
  const shown = (await surface.innerText()).replace(/\s+/g, "");
  return shown.includes(text.replace(/\s+/g, ""));
}

/**
 * Focus a pane the way a person does.
 *
 * ⚠ ALWAYS THE SURFACE NOW. This used to click `[data-pdmux-guard]` when it was there and
 * fall back to the surface when it was not — the guard was a transparent button laid over
 * the terminal. It no longer takes pointer events at all (that occlusion was what stopped
 * a drag ever selecting anything), so clicking it hangs on Playwright's hit-target check.
 * The surface works in both states, which is why the fallback existed in the first place.
 */
async function focusPane(pane: ReturnType<Page["locator"]>): Promise<void> {
  await pane.locator("[data-pdmux-surface]").click();
}

interface SavedLayout {
  name: string;
  payload: Record<string, unknown>;
  isDefault: boolean;
}

/**
 * The user's saved layout, so a test that rearranges the grid can put it back exactly.
 *
 * ⚠ The picker's "existing session" list is this machine's REAL multiplexer sessions —
 * other people's editors, other agents' shells. A test may attach to one to read it,
 * but it must never leave a pane pointed at one, and it must never type into one.
 */
async function captureLayout(request: import("@playwright/test").APIRequestContext): Promise<SavedLayout | null> {
  const response = await request.get("/api/prefs");
  if (!response.ok()) return null;
  const prefs = (await response.json()) as { layouts?: SavedLayout[] };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  return layout ? { name: layout.name, payload: layout.payload, isDefault: layout.isDefault ?? true } : null;
}

async function restoreLayout(
  request: import("@playwright/test").APIRequestContext,
  saved: SavedLayout | null,
): Promise<void> {
  if (!saved) {
    const response = await request.delete("/api/prefs/layouts/default");
    expect(response.ok(), "remove the layout created by the test").toBeTruthy();
    return;
  }
  const response = await request.put(`/api/prefs/layouts/${encodeURIComponent(saved.name)}`, {
    data: { payload: saved.payload, isDefault: saved.isDefault },
  });
  expect(response.ok(), "restore the layout captured before the test").toBeTruthy();
}

async function ensureGridPane(page: Page, host: HostRow): Promise<ReturnType<Page["locator"]>> {
  const panes = page.locator("[data-pdmux-pane]:not([hidden])");
  if ((await panes.count()) === 0) {
    await page.locator("[data-testid='add-terminal']").click();
    const picker = page.locator("[data-pdmux-popover='target-picker']");
    await expect(picker).toBeVisible();
    await picker.locator(`[data-pdmux-host='${host.id}']`).click();
    await picker.locator("[data-pdmux-action='new']").click();
  }
  await expect(panes.first()).toBeVisible();
  return panes.first();
}

// Its own account, host and agent (see `E2E_ADMIN`): these specs write the dashboard
// layout, and sharing an account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });


test.describe("pdmux terminal", () => {
  test("[TC-PDTERM-120] a detached pane opens a real PTY and echoes", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    const session = `e2e${Date.now().toString().slice(-6)}`;
    await ready(page, `/terminal?host=${host.id}&kind=new&session=${session}`);

    const pane = page.locator("[data-pdmux-pane]");
    await expect(pane).toBeVisible();
    await expectOnScreen(pane, "detached pane");

    // xterm paints into its own DOM; the shell prompt is the proof the relay
    // reached a PTY at all.
    const surface = page.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await surface.innerText()).trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const marker = `pdmux-echo-${Date.now().toString().slice(-5)}`;
    await surface.click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    // The echoed line comes back through the agent, the relay and the socket —
    // seeing it twice (command + output) is what a real round trip looks like.
    await expect
      .poll(async () => (await surface.innerText()).split(marker).length - 1, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
  });

  test("[TC-PDTERM-121] the dashboard opens a pane in a grid cell", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    await ready(page, "/");
    const pane = await ensureGridPane(page, host);
    await expectOnScreen(pane, "grid pane");
    await expect(pane.locator("[data-pdmux-surface] .xterm-rows")).toBeVisible({ timeout: 15_000 });
    await expectViewportBound(page);
  });

  test("[TC-PDTERM-123] closing a pane asks first, and cancelling keeps it", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    const saved = await captureLayout(request);
    await ready(page, "/");
    const panes = page.locator("[data-pdmux-pane]:not([hidden])");
    await ensureGridPane(page, host);

    // Identify the pane by its slot id and assert on THAT one. Counting panes is a
    // moving baseline — neighbours finish mounting while this test runs — and a count
    // assertion then fails for reasons that have nothing to do with closing.
    const slotId = await panes.first().getAttribute("data-pdmux-pane");
    expect(slotId).toBeTruthy();
    const pane = page.locator(`[data-pdmux-pane='${slotId}']`);
    // Destructive actions live behind More, away from the target/output/zoom controls.
    const more = pane.locator("[data-pdmux-pane-more]");
    const chooseClose = async (): Promise<void> => {
      await more.click();
      await page.locator("[data-testid='pane-actions-menu'] [data-pdmux-close]").click();
    };
    const dialog = page.locator("[data-testid='pane-close-confirm']");

    await chooseClose();
    await expect(dialog).toBeVisible();
    // No typing gate here: the session survives on the host, so a second button is the
    // right weight. The wording has to name what is being closed.
    await expect(dialog).toContainText(host.label ?? host.id);
    await expect(page.locator("[data-testid='pane-close-confirm-input']")).toHaveCount(0);

    // Cancelling is the whole point of the gate: the pane is still there afterwards.
    await dialog.getByRole("button", { name: /cancel|취소/i }).click();
    await expect(dialog).toBeHidden();
    await expect(pane).toBeVisible();
    await expect(pane.locator("[data-pdmux-surface] .xterm-rows")).toBeVisible({ timeout: 15_000 });

    // Confirming closes that pane, and the cell it leaves behind is assignable again.
    await chooseClose();
    await expect(dialog).toBeVisible();
    await page.locator("[data-testid='pane-close-confirm-confirm']").click();
    await expect(dialog).toBeHidden();
    await expect(pane).toHaveCount(0);
    await expect(page.locator(".pdmux-pane-empty").first()).toBeVisible();

    // Restore the layout that was captured before the close, rather than assigning some
    // other target: the picker's "existing session" list is the machine's REAL
    // multiplexer sessions, so a teardown that grabs one attaches a pane to somebody's
    // live work — which is how this suite ended up typing into a session it did not own.
    await restoreLayout(request, saved);
  });

  test("[TC-PDUI-142] the focused pane is marked on its frame, not over the terminal", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    await ready(page, "/");
    const panes = page.locator("[data-pdmux-pane]:not([hidden])");
    // Wait for the neighbour rather than sampling the count once: panes mount as their
    // relays attach, so an instantaneous count fails for a reason that has nothing to do
    // with focus.
    //
    // …and CREATE one if the account does not have it. A first visit now opens four cells
    // with at most ONE of them live (it joins `main` if the host has it, and never grabs
    // somebody else's session), so "there are two panes" is no longer something a spec may
    // assume about whoever's account it runs under.
    if ((await panes.count()) < 2) {
      await page.locator("[data-testid='add-terminal']").click();
      const picker = page.locator("[data-pdmux-popover='target-picker']");
      await expect(picker).toBeVisible();
      await picker.locator(`[data-pdmux-host='${host.id}']`).click();
      const own = picker.locator("[data-pdmux-session='pdmux-e2e']");
      // A session this suite owns, never one that belongs to the machine's user.
      if ((await own.count()) > 0) await own.click();
      else {
        await picker.getByLabel(/session name/i).fill("pdmux-e2e");
        await picker.locator("[data-pdmux-action='new']").click();
      }
    }
    // …and CREATE one if the account does not have it. A first visit now opens four cells
    // with at most ONE of them live, so "there are two panes" is no longer something a spec
    // may assume about the account it runs under.
    if ((await panes.count()) < 2) {
      await page.locator("[data-testid='add-terminal']").click();
      const picker = page.locator("[data-pdmux-popover='target-picker']");
      await expect(picker).toBeVisible();
      await picker.locator(`[data-pdmux-host='${host.id}']`).click();
      const own = picker.locator("[data-pdmux-session='pdmux-e2e']");
      // A session this suite owns, never one that belongs to the machine's user.
      if ((await own.count()) > 0) await own.click();
      else {
        await picker.getByLabel(/session name/i).fill("pdmux-e2e");
        await picker.locator("[data-pdmux-action='new']").click();
      }
    }
    await expect
      .poll(async () => panes.count(), { timeout: 20_000, message: "needs a neighbour to be distinguishable from" })
      .toBeGreaterThan(1);

    // Body clicks focus by default. Header clicks and the zoom button toggle zoom;
    // the old global body-click mode switch stays gone.
    await expect(page.locator("[data-testid='toggle-click-action']")).toHaveCount(0);

    // Start from a known state: focus the FIRST pane, then move it to the second. Asserting
    // "pane 1 is focused, pane 0 is not" only means something if focus actually moved.
    await focusPane(panes.nth(0));
    await expect(panes.nth(0)).toHaveAttribute("data-pdmux-focused", "true");
    await expect(panes.nth(0).locator("[data-pdmux-pane-state='focused']")).toBeVisible();

    const target = panes.nth(1);
    await focusPane(target);
    await expect(target).toHaveAttribute("data-pdmux-focused", "true");
    await expect(target).toHaveAttribute("data-pdmux-zoomed", "false");
    await expect(panes.nth(0)).toHaveAttribute("data-pdmux-focused", "false");
    await expect(target.locator("[data-pdmux-retarget]")).toBeVisible();
    await expect(target.locator("[data-pdmux-history]")).toBeVisible();
    await expect(target.locator("[data-pdmux-zoom]")).toBeVisible();
    await target.locator("[data-pdmux-pane-more]").click();
    await expect(page.locator("[data-testid='pane-actions-menu'] [data-pdmux-detach]")).toBeVisible();
    await expect(page.locator("[data-testid='pane-actions-menu'] [data-pdmux-close]")).toBeVisible();
    await page.keyboard.press("Escape");

    const frames = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[data-pdmux-pane]:not([hidden])")] as HTMLElement[];
      const read = (el: HTMLElement) => {
        const style = getComputedStyle(el);
        return `${style.borderTopColor}|${style.outlineWidth}|${style.outlineColor}`;
      };
      const focused = nodes.find((n) => n.dataset.pdmuxFocused === "true");
      const other = nodes.find((n) => n.dataset.pdmuxFocused !== "true");
      const surface = focused?.querySelector("[data-pdmux-surface]") as HTMLElement | null;
      const rect = surface?.getBoundingClientRect();
      const hit = rect
        ? document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
        : null;
      return {
        focused: focused ? read(focused) : null,
        other: other ? read(other) : null,
        // The mark must be on the frame: an overlay over the surface is unreadable AND
        // unclickable, which is exactly how the stuck drag dim was reported.
        surfaceReached: Boolean(hit && surface && (hit === surface || surface.contains(hit))),
      };
    });
    expect(frames.focused, "the focused pane must look different from its neighbour").not.toBe(frames.other);
    expect(frames.surfaceReached, "a pointer at the terminal's centre must reach the terminal").toBe(true);
    // And nothing is left dimmed by a gesture that already finished.
    await expect(page.locator(".pdmux-dragging")).toHaveCount(0);
    await expectViewportBound(page);
  });

  /**
   * Put a solo pane on the grid with NOTHING focused, wait for its shell, and give back
   * the row rectangle of a marker we just echoed.
   *
   * ⚠ `focusId: null` IS THE POINT, not an oversight. The defect only ever appeared on an
   * unfocused pane — that is where the click guard was mounted — and `seedSoloPane` helpfully
   * focuses what it seeds, which would tidy the bug away before the test could see it. A
   * fresh layout has `focusId: null` for every pane, so this is also the ordinary state.
   */
  async function paneWithMarker(
    page: Page,
    request: import("@playwright/test").APIRequestContext,
    hostId: string,
    marker: string,
  ): Promise<{ x: number; y: number; width: number }> {
    await request.put("/api/prefs/layouts/default", {
      data: {
        payload: {
          mode: "split4",
          page: 0,
          slots: [{ id: "copy-1", hostId, kind: "shell", session: null }],
          focusId: null,
          zoomId: null,
        },
        isDefault: true,
      },
    });
    await ready(page, "/");
    const surface = page.locator("[data-pdmux-surface]").first();
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await surface.innerText()).trim().length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Typing needs focus, and focusing through the UI is what the fix changes — so go
    // straight to xterm's own input, which is how the other specs type into a guarded pane.
    await surface.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect.poll(async () => terminalShows(surface, marker), { timeout: 20_000 }).toBe(true);

    // The rectangle of the row the ECHO landed on (the last one that carries it, so the
    // command line itself is not what gets dragged).
    const rect = await page.evaluate((needle) => {
      const rows = [...document.querySelectorAll(".xterm-rows > div")];
      const hit = rows.filter((row) => (row.textContent ?? "").includes(needle)).pop();
      if (!hit) return null;
      const box = hit.getBoundingClientRect();
      return { x: box.left, y: box.top + box.height / 2, width: box.width };
    }, marker);
    expect(rect, "the echoed marker was not on any row").not.toBeNull();
    return rect as { x: number; y: number; width: number };
  }

  /** Drag across a row, optionally holding Shift, and let the release settle. */
  async function dragAcross(
    page: Page,
    row: { x: number; y: number; width: number },
    options: { shift?: boolean } = {},
  ): Promise<void> {
    if (options.shift) await page.keyboard.down("Shift");
    // ⚠ x + 1, NOT x + 4. A cell is about 8px wide and xterm snaps a selection to the
    // nearest boundary, so starting 4px in rounds PAST column 0 — measured: the clipboard
    // came back holding `dmux-copy-…` for a marker of `pdmux-copy-…`, one character short.
    await page.mouse.move(row.x + 1, row.y);
    await page.mouse.down();
    // More than one move: a single jump can land inside xterm's own click threshold and
    // register as a click rather than a drag.
    await page.mouse.move(row.x + row.width * 0.4, row.y, { steps: 6 });
    await page.mouse.move(row.x + row.width - 8, row.y, { steps: 6 });
    await page.mouse.up();
    if (options.shift) await page.keyboard.up("Shift");
  }

  /** What the clipboard holds, polled — a fixed sleep here was measurably flaky. */
  async function clipboard(page: Page): Promise<string> {
    return page.evaluate(() => navigator.clipboard.readText());
  }

  test("[TC-PDTERM-132] dragging a terminal copies what was dragged", async ({ page, request, baseURL }) => {
    /**
     * REPORTED: "드래그해서 복사가 안 됩니다". A transparent `<button class="pdmux-guard">` sat
     * at `inset: 0` over every unfocused pane, so it won the hit test and xterm never saw
     * the press — not cancelled, occluded. Nothing was selected, so there was nothing to
     * copy, and `focusId` is `null` on a fresh layout, i.e. EVERY pane was like that.
     *
     * ⚠ THIS HAS TO BE A REAL BROWSER. The unit specs dispatch events programmatically, and
     * a programmatic dispatch bubbles without hit-testing — they pass with the guard back in
     * place. Only a browser that actually hit-tests can tell the occlusion is gone.
     */
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL ?? "http://localhost:5001",
    });

    const saved = await captureLayout(request);
    try {
      const marker = `pdmux-copy-${Date.now().toString().slice(-6)}`;
      const row = await paneWithMarker(page, request, host.id, marker);
      // A sentinel, so "the clipboard contains the marker" cannot pass on a stale value.
      await page.evaluate(() => navigator.clipboard.writeText("pdmux-sentinel"));

      await dragAcross(page, row);

      await expect.poll(() => clipboard(page), { timeout: 10_000 }).toContain(marker);
    } finally {
      await restoreLayout(request, saved);
    }
  });

  test("[TC-PDTERM-133] Shift+drag copies from a terminal that is reporting the mouse", async ({
    page,
    request,
    baseURL,
  }) => {
    /**
     * The everyday case on this deployment. When a program turns mouse reporting on — tmux
     * with `mouse on`, vim, and every coding agent that draws its own UI — xterm forwards a
     * plain drag to the program instead of selecting, and Shift is the documented escape.
     * Measured on the live dashboard: the panes carry `enable-mouse-events` while tmux's own
     * `mouse` option is OFF, so it is the program inside doing it. That makes Shift+drag the
     * ONLY way to select there, and the guard was eating that too.
     *
     * ⚠ Reporting is turned on with a raw DECSET rather than by configuring tmux, so the
     * test does not depend on anybody's dotfiles and cleans up after itself.
     */
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL ?? "http://localhost:5001",
    });

    const saved = await captureLayout(request);
    try {
      const marker = `pdmux-shift-${Date.now().toString().slice(-6)}`;
      const row = await paneWithMarker(page, request, host.id, marker);

      // DECSET 1000 (send button events) + 1006 (SGR encoding) — what a TUI asks for.
      await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => page.locator(".xterm").first().getAttribute("class"), { timeout: 10_000 })
        .toContain("enable-mouse-events");

      // ⚠ ORDER MATTERS, AND GETTING IT WRONG MADE THIS TEST UNFALSIFIABLE. The control
      // drag below focuses the pane as a side effect — which unmounts the guard — so when
      // it ran first, the Shift drag that followed was no longer testing a guarded pane.
      // With the occlusion deliberately restored, the test still passed. The gesture under
      // test has to go FIRST, on a pane that is demonstrably still guarded.
      await expect(page.locator("[data-pdmux-pane]").first()).toHaveAttribute("data-pdmux-focused", "false");
      await expect(page.locator("[data-pdmux-guard]")).toHaveCount(1);

      await page.evaluate(() => navigator.clipboard.writeText("pdmux-sentinel"));
      await dragAcross(page, row, { shift: true });
      await expect.poll(() => clipboard(page), { timeout: 10_000 }).toContain(marker);

      // ⚠ THE CONTROL, and without it the assertion above proves nothing: if mouse
      // reporting were not really on, a PLAIN drag would select too and Shift would have
      // been irrelevant. A reporting terminal has to swallow the plain drag.
      await page.evaluate(() => navigator.clipboard.writeText("pdmux-sentinel"));
      await dragAcross(page, row);
      // Given a moment to be wrong: this asserts something did NOT happen, so it waits as
      // long as the positive case would before believing it.
      await page.waitForTimeout(1_000);
      expect(
        await clipboard(page),
        "a plain drag selected text on a terminal that is reporting the mouse — reporting is not really on",
      ).toBe("pdmux-sentinel");
    } finally {
      // Put the terminal back the way it was found, whatever happened above.
      await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'").catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      await restoreLayout(request, saved);
    }
  });

  test("[TC-PDTERM-134] Shift+drag copies on a Mac too, where xterm wants Option", async ({
    page,
    request,
    baseURL,
  }) => {
    /**
     * REPORTED: with tmux + a coding agent running, dragging was taken by the program and
     * nothing copied — and in a NATIVE terminal the same user does "shift+drag, then
     * Cmd+C" and it works. The give-away was the Cmd: they are on a Mac.
     *
     * ⚠ xterm decides this with `isMac ? altKey && macOptionClickForcesSelection : shiftKey`
     * and offers no way to change it, so on macOS Shift is ignored and Option is the
     * modifier. Terminal.app and iTerm2 both use Shift, so the gesture a Mac user reaches
     * for did nothing. `createXtermSurface` translates it at `mousedown`, and only while a
     * program is actually reporting the mouse.
     *
     * ⚠ EMULATED VIA `navigator.platform`, NOT the user agent. Overriding only the UA
     * emulates nothing — xterm reads `platform` — and the first attempt at this
     * measurement did exactly that and "proved" Shift already worked, having measured
     * Linux twice.
     */
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL ?? "http://localhost:5001",
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    });

    const saved = await captureLayout(request);
    try {
      const marker = `pdmux-mac-${Date.now().toString().slice(-6)}`;
      const row = await paneWithMarker(page, request, host.id, marker);
      expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel");

      await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => page.locator(".xterm").first().getAttribute("class"), { timeout: 10_000 })
        .toContain("enable-mouse-events");

      await page.evaluate(() => navigator.clipboard.writeText("pdmux-sentinel"));
      await dragAcross(page, row, { shift: true });
      await expect.poll(() => clipboard(page), { timeout: 10_000 }).toContain(marker);
    } finally {
      await page.keyboard.type("printf '\\033[?1000l\\033[?1006l'").catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      await restoreLayout(request, saved);
    }
  });

  test("[TC-PDTERM-122] work survives a trip to host management", async ({ page, request }) => {
    // The heaviest spec in the suite: a PTY round trip, then two navigations, then a
    // reattach and a second round trip. It does not deserve the default budget.
    test.slow();
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    const saved = await captureLayout(request);
    await ready(page, "/");

    // A session this test OWNS, under a name nobody would mistake for theirs.
    //
    // Taking whatever sits in the first cell means typing into whichever multiplexer
    // session the layout happens to hold — and those are the machine's REAL sessions
    // (editors, other agents). This spec typed `echo` into a live agent's prompt that
    // way. A plain `shell` target is not an option either: this test is about work
    // SURVIVING a teardown, and a bare shell dies with its pane, so only a multiplexer
    // session can prove it.
    const SESSION = "pdmux-e2e";
    // Retarget an existing cell rather than adding one: the grid is usually full, and
    // then "add terminal" has no cell to fill and quietly does nothing. The layout
    // captured above is put back at the end, so borrowing a cell costs the user nothing.
    const firstPane = await ensureGridPane(page, host);
    await firstPane.locator("[data-pdmux-retarget]").click();
    const picker = page.locator("[data-pdmux-popover='target-picker']");
    await expect(picker).toBeVisible();
    await picker.locator(`[data-pdmux-host='${host.id}']`).click();
    const existing = picker.locator(`[data-pdmux-session='${SESSION}']`);
    if ((await existing.count()) > 0) {
      // Reuse it, so repeated runs do not litter the host with sessions.
      await existing.click();
    } else {
      await picker.getByLabel(/session name/i).fill(SESSION);
      await picker.locator("[data-pdmux-action='new']").click();
    }

    // Find it by its label, not by position: cells carry a CSS `order`, so the pane the
    // test just filled is not the last one in DOM order.
    const ownPane = (): ReturnType<typeof page.locator> =>
      page
        .locator("[data-pdmux-pane]:not([hidden])")
        .filter({ has: page.locator(`.pdmux-pane-label:has-text("${SESSION}")`) })
        .first();
    const pane = ownPane();
    await expect(pane).toBeVisible();
    const surface = pane.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 15_000 });

    // Wait for the shell to say something first: input typed before the PTY is attached
    // is genuinely lost (the relay refuses to replay keystrokes into a shell that may
    // have moved on), and that made this test flaky rather than red.
    await expect
      .poll(async () => (await surface.innerText()).trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const marker = `pdmux-keep-${Date.now().toString().slice(-5)}`;
    // Retry the whole keystroke round trip rather than typing once and hoping. "The
    // prompt is on screen" does not mean "the relay is carrying input yet", and a single
    // attempt made this test fail for a timing reason unrelated to what it checks.
    // Focus the terminal's own input rather than clicking the surface: an unfocused pane
    // carries the click guard, so a click would land on the guard instead.
    // Echoing the same marker twice is harmless — this is a shell the test created.
    await expect(async () => {
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");
      await expect.poll(async () => terminalShows(surface, marker), { timeout: 5_000 }).toBe(true);
    }).toPass({ timeout: 25_000 });

    // The dashboard page owns the grid, so leaving it really does tear the panes down —
    // that is the honest cost of the terminals living in a page rather than the shell.
    await openSidebar(page);
    await page.locator("[data-testid='nav-hosts']").click();
    await expect(page.locator("[data-testid='hosts-panel']")).toBeVisible();
    await expect(page.locator("[data-pdmux-grid]")).toHaveCount(0);

    // What must NOT be lost is the work: the slot keeps its multiplexer session, so
    // coming back reattaches to the same shell with the same scrollback.
    await page.locator("[data-testid='open-dashboard']").click();
    const back = ownPane().locator("[data-pdmux-surface]");
    await expect(back.locator(".xterm-rows")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => terminalShows(back, marker), { timeout: 20_000 }).toBe(true);

    // Give the user their grid back — this test added a cell to work in.
    await restoreLayout(request, saved);
  });
});
