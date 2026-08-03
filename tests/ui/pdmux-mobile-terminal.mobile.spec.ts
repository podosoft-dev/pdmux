import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { expectOnScreen, expectViewportBound } from "../helpers/geometry";
import { ready } from "../helpers/hydration";
import { e2eAdminState } from "../helpers/accounts";

/**
 * Typing at a terminal from a phone.
 *
 * The user's own words for why this matters: they type in terminals on the phone often. So
 * these specs are about the three things that made that impossible rather than merely
 * cramped — a 3x3 grid of 12-character panes, a tap that never raised the keyboard
 * (`TerminalSurface.focus()` shipped with no call site), and no Esc/Tab/Ctrl/arrows on a
 * software keyboard.
 */

interface HostRow {
  id: string;
  label: string;
  online: boolean;
  enabled: boolean;
}

async function onlineHost(request: APIRequestContext): Promise<HostRow | null> {
  const response = await request.get("/api/hosts");
  if (!response.ok()) return null;
  const hosts = (await response.json()) as HostRow[];
  return hosts.find((host) => host.online && host.enabled) ?? null;
}

/**
 * A host to point a pane at — online if this machine has one, otherwise any enabled host.
 *
 * The specs above type into a real PTY and must skip without an agent. TC-PDTERM-131 asserts
 * chrome that has to be on screen BEFORE the first tap, and a pane on an unreachable host
 * renders it just the same (the layout keeps such a slot on purpose — it works again when the
 * host comes back), so it stays honest on a machine whose agent is not attached.
 */
async function paneHost(request: APIRequestContext): Promise<HostRow | null> {
  const response = await request.get("/api/hosts");
  if (!response.ok()) return null;
  const hosts = (await response.json()) as HostRow[];
  return hosts.find((host) => host.online && host.enabled) ?? hosts.find((host) => host.enabled) ?? null;
}

interface SavedLayout {
  name: string;
  payload: Record<string, unknown>;
  isDefault: boolean;
}

async function readLayout(request: APIRequestContext): Promise<SavedLayout | null> {
  const response = await request.get("/api/prefs");
  if (!response.ok()) return null;
  const prefs = (await response.json()) as { layouts?: SavedLayout[] };
  const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
  return layout ? { name: layout.name, payload: layout.payload, isDefault: layout.isDefault ?? true } : null;
}

async function writeLayout(request: APIRequestContext, saved: SavedLayout | null): Promise<void> {
  if (!saved) return;
  await request.put(`/api/prefs/layouts/${encodeURIComponent(saved.name)}`, {
    data: { payload: saved.payload, isDefault: saved.isDefault },
  });
}

/** Show a tab and wait for the shell to agree. */
async function showTab(page: Page, view: "hosts" | "terminal" | "git"): Promise<void> {
  await page.locator(`[data-testid='shell-tab-${view}']`).click();
  await expect(page.locator("[data-testid='dashboard-shell']")).toHaveAttribute("data-view", view);
}

/**
 * Point the pane on screen at a session this test owns, and hand back the layout that was
 * there before.
 *
 * ⚠ NEVER TYPE INTO WHATEVER PANE IS ON SCREEN. The picker's session list is this
 * machine's REAL multiplexer sessions — editors, other agents' shells. A spec that typed
 * into the first pane sent `echo pdmux-key-27941` straight into a live agent session
 * (observed). A named session cannot be mistaken for someone's work.
 */
const OWN_SESSION = "pdmux-e2e";

async function useOwnSession(page: Page, hostId: string): Promise<void> {
  const pane = page.locator("[data-pdmux-pane]:not([hidden])").first();
  // A first visit now opens four EMPTY cells (it joins `main` only if the host has one, and
  // never grabs somebody else's session), so there may be no pane to retarget — then the
  // add control fills the first empty cell instead.
  if ((await pane.count()) > 0) await pane.locator("[data-pdmux-retarget]").click();
  else await page.locator("[data-testid='add-terminal']").click();
  const picker = page.locator("[data-pdmux-popover='target-picker']");
  await expect(picker).toBeVisible();
  await picker.locator(`[data-pdmux-host='${hostId}']`).click();
  const existing = picker.locator(`[data-pdmux-session='${OWN_SESSION}']`);
  if ((await existing.count()) > 0) {
    // Reuse it, so repeated runs do not litter the host with sessions.
    await existing.click();
  } else {
    await picker.getByLabel(/session name/i).fill(OWN_SESSION);
    await picker.locator("[data-pdmux-action='new']").click();
  }
  /**
   * …then page to it. A phone shows ONE cell and the assignment lands in the first empty
   * cell, which is not necessarily the cell on screen. Stepping the pager is what a person
   * would do, and it is bounded.
   */
  const label = page.locator(`.pdmux-pane-label:has-text("${OWN_SESSION}")`);
  await expect(async () => {
    if ((await label.count()) === 0) await page.locator("[data-testid='page-next']").click();
    await expect(label).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

// Its own account, host and agent (see `E2E_ADMIN`): these specs write the dashboard
// layout, and sharing an account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });


test.describe("pdmux terminal on a phone", () => {
  test("[TC-PDTERM-124] one pane fills the screen and the stored split is untouched", async ({ page, request }) => {
    const saved = await readLayout(request);
    // A desktop split of nine on a 390px screen is nine panes about twelve characters
    // wide. The phone renders a projection instead — and must not write it back, because
    // this document is shared with the user's desktop.
    await writeLayout(request, saved ? { ...saved, payload: { ...saved.payload, mode: "split9" } } : null);
    await ready(page, "/");

    // CELLS, not panes: a cell may be empty (a first visit opens four and joins at most one
    // session), and the claim here is that a phone renders exactly ONE of them.
    // `:not([hidden])` matters: a pane that scrolled off the page stays MOUNTED and hidden
    // (that is what keeps its session alive), so counting every cell counts history too.
    const cells = page.locator("[data-pdmux-cell]:not([hidden])");
    await expect(cells).toHaveCount(1);
    await expectOnScreen(cells.first(), "the one cell on a phone");
    const panes = page.locator("[data-pdmux-pane]:not([hidden])");
    expect(await panes.count(), "a phone must never render two terminals at once").toBeLessThanOrEqual(1);
    const cols = await page.evaluate(() =>
      getComputedStyle(document.querySelector("[data-pdmux-grid]") as Element).gridTemplateColumns.split(" ").length,
    );
    expect(cols).toBe(1);

    // Page through a terminal or two, which is what the pager means here…
    await page.locator("[data-testid='page-next']").click();
    await expect(cells).toHaveCount(1);
    await page.reload();
    await ready(page, "/");

    // …and the desktop's split is still nine.
    const after = await readLayout(request);
    expect(after?.payload.mode, "a phone rewrote the layout everyone's desktop reads").toBe("split9");
    await writeLayout(request, saved);
  });

  test("[TC-PDTERM-125] a tab switch does not unmount the terminals", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;

    const saved = await readLayout(request);
    await ready(page, "/");
    await showTab(page, "terminal");
    // Bring up a pane this suite owns: a first visit may have none at all.
    await useOwnSession(page, host.id);
    const pane = page.locator("[data-pdmux-pane]:not([hidden])").first();
    const surface = pane.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 20_000 });

    // Mark the live element. If the region were unmounted rather than hidden, this marker
    // (and the session behind it) would be gone — a plain `shell` pane dies with its pane
    // and an attached session loses its scrollback.
    await pane.evaluate((el: HTMLElement & { __pdmuxProbe?: number }) => (el.__pdmuxProbe = 1));

    await showTab(page, "git");
    await expect(page.locator("[data-pdmux-grid]")).toBeHidden();
    await showTab(page, "terminal");

    const probe = await pane.evaluate((el: HTMLElement & { __pdmuxProbe?: number }) => el.__pdmuxProbe ?? null);
    expect(probe, "the pane was re-created, so its session was dropped").toBe(1);

    // …and it re-fitted: xterm's screen fills its box again rather than keeping the
    // dimensions it had while hidden.
    const fit = await pane.evaluate((el) => ({
      body: Math.round(el.querySelector(".pdmux-pane-body")?.getBoundingClientRect().width ?? 0),
      screen: Math.round(el.querySelector(".xterm-screen")?.getBoundingClientRect().width ?? 0),
    }));
    expect(fit.screen).toBeGreaterThan(0);
    expect(fit.body - fit.screen).toBeLessThan(24);
    await expectViewportBound(page);
    await writeLayout(request, saved);
  });

  test("[TC-PDTERM-126] tapping a pane raises the keyboard and the helper row sends keys", async ({
    page,
    request,
  }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await ready(page, "/");
    await showTab(page, "terminal");
    // Everything below TYPES, so it must be typing into a session this test created.
    await useOwnSession(page, host.id);
    const pane = page.locator("[data-pdmux-pane]:not([hidden])").first();
    const surface = pane.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 20_000 });

    // A tap must hand focus to the terminal's own input. Nothing called
    // `TerminalSurface.focus()` before, so the guard took the tap, unmounted, and focus
    // fell to <body> — on a phone that means the software keyboard never appears, which is
    // the whole difference between "cramped" and "cannot type".
    // Tap what a finger actually lands on: an unfocused pane wears the click guard, and it
    // is the guard's release that hands focus to the terminal.
    // The guard is keyboard-only now; a finger lands on the terminal itself.
    const guard = pane.locator("[data-pdmux-surface]");
    if ((await guard.count()) > 0) await guard.tap();
    else await surface.tap();
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.className ?? ""), { timeout: 10_000 })
      .toContain("xterm-helper-textarea");

    // The helper row exists because no software keyboard has these keys.
    const keys = page.locator("[data-testid='terminal-keys']");
    await expect(keys).toBeVisible();
    await expectOnScreen(keys, "soft keyboard helper row");

    /**
     * Enter is one page turn away on the row — there is NO POPOVER any more.
     *
     * It used to open one, and a popover is a thing on top of the terminal it types into:
     * reported from a phone as covering the screen, and still 20.7% of the pane after it was
     * shrunk to a single row. `⌘` now turns the row's own five key cells instead, so the
     * terminal is never covered at all. TC-PDUI-197 owns the cycling; this is the live proof
     * that a key reached this way actually arrives at the PTY.
     */
    const marker = `pdmux-key-${Date.now().toString().slice(-5)}`;
    await page.keyboard.type(`echo ${marker}`);
    const paneBefore = await surface.boundingBox();
    await page.locator("[data-testid='terminal-keys-cycle']").tap();
    await expect(page.locator("[data-testid='terminal-key-enter']")).toBeVisible();
    await page.locator("[data-testid='terminal-key-enter']").tap();
    await expect
      .poll(async () => (await surface.innerText()).replace(/\s+/g, ""), { timeout: 20_000 })
      .toContain(marker);

    // ⚠ Neither a key nor the page turn may steal focus, or the keyboard closes under the
    // user's hand — which would make the whole row useless for its purpose.
    expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");

    /**
     * ⚠ AND NOTHING IS DRAWN OVER THE TERMINAL. This is the assertion the popover could never
     * pass: no element claiming to be one exists, and turning the page does not cost the pane
     * a single pixel of height — which only an engine can answer, because jsdom lays nothing
     * out. The row was always there; the sets ride in it.
     */
    expect(await page.locator("[data-pdmux-popover='terminal-keys']").count(), "the popover came back").toBe(0);
    const paneAfter = await surface.boundingBox();
    expect(paneBefore && paneAfter, "no box to compare").toBeTruthy();
    if (paneBefore && paneAfter) {
      expect(paneAfter.height, "turning the page shrank the terminal").toBe(paneBefore.height);
    }
    // …and the row is still exactly one line of controls, on the narrowest phone we support.
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForTimeout(300);
    const rowTops = await page
      .locator("[data-pdmux-keys] button")
      .evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))]);
    expect(rowTops, `the key row wrapped onto ${rowTops.length} lines at 320px`).toHaveLength(1);

    // Scrolling, which a phone had no way to do at all — a mouse has a wheel and a finger
    // had nothing, so everything above the fold was unreachable. The buttons ARE that wheel
    // now (TC-PDTERM-135 owns what they put on the wire); all that matters here is that
    // pressing one does not take the focus, i.e. the software keyboard, with it.
    const scrollUp = page.locator("[data-testid='terminal-scroll-up']");
    if ((await scrollUp.count()) > 0) {
      await scrollUp.tap();
      expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");
    }
    await expectViewportBound(page);

    // Give the user their own pane back.
    await writeLayout(request, saved);
  });

  test("[TC-PDTERM-127] a composed syllable arrives once, not as separate jamo", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    // Record what the page sends, before anything opens a socket. `WebSocket.prototype.send`
    // is the app's own transport, so this observes the real path without touching the app.
    await page.addInitScript(() => {
      const original = WebSocket.prototype.send;
      const seen: string[] = [];
      (window as unknown as { __pdmuxSent: string[] }).__pdmuxSent = seen;
      WebSocket.prototype.send = function patched(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string") seen.push(data);
        return original.call(this, data);
      };
    });
    await ready(page, "/");
    await showTab(page, "terminal");
    await useOwnSession(page, host.id);
    const pane = page.locator("[data-pdmux-pane]:not([hidden])").first();
    const surface = pane.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 20_000 });
    // The guard is keyboard-only now; a finger lands on the terminal itself.
    const guard = pane.locator("[data-pdmux-surface]");
    if ((await guard.count()) > 0) await guard.tap();
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.className ?? ""), { timeout: 10_000 })
      .toContain("xterm-helper-textarea");

    /**
     * REPORTED FROM A PHONE: Korean came out as `ㅎㅏㄴ` instead of `한`.
     *
     * The sequence below is what iOS reports for marked text — `input` events with
     * `inputType: "insertText"` AND `isComposing: true`, one per jamo, then a commit. xterm's
     * own handler ignores `isComposing`, so each of those used to be sent to the PTY. It is
     * synthesised here because no headless engine has a Korean IME, and CDP's own
     * composition path reports `insertCompositionText` (i.e. it cannot reproduce the bug).
     */
    /**
     * Measured ON THE WIRE, not on screen.
     *
     * The screen is the wrong instrument here: the session is reused across runs, the pane
     * draws a status bar with a clock in it, `sh` has no line editing to clear with, and a
     * re-fit reflows wrapped rows — so its text moves for reasons that have nothing to do
     * with this bug. What the bug is actually about is what the browser SENDS, so the socket
     * is where it is measured. `input` frames are the protocol's own shape
     * (`terminalClientFrameSchema`), so this reads the real contract rather than a proxy.
     */
    const sentInputs = async (): Promise<string[]> =>
      page.evaluate(() => {
        const frames = (window as unknown as { __pdmuxSent?: string[] }).__pdmuxSent ?? [];
        return frames
          .map((raw) => {
            try {
              return JSON.parse(raw) as { type?: string; data?: string };
            } catch {
              return null;
            }
          })
          .filter((frame): frame is { type: string; data: string } => frame?.type === "input" && typeof frame.data === "string")
          .map((frame) => frame.data);
      });

    const beforeCount = (await sentInputs()).length;

    /**
     * REPORTED FROM A PHONE: Korean came out as `ㅎㅏㄴ` instead of `한`.
     *
     * The sequence below is what iOS reports for marked text — `input` events with
     * `inputType: "insertText"` AND `isComposing: true`, one per jamo, then a commit. xterm's
     * own handler ignores `isComposing`, so each of those used to be sent to the PTY. It is
     * synthesised here because no headless engine has a Korean IME, and CDP's own composition
     * path reports `insertCompositionText` (i.e. it cannot reproduce the bug).
     */
    await page.evaluate(() => {
      const area = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
      const composing = (data: string) => {
        area.value = data;
        area.dispatchEvent(
          new InputEvent("input", { data, inputType: "insertText", isComposing: true, bubbles: true, composed: true }),
        );
      };
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      for (const step of ["ㅎ", "하", "한"]) {
        area.dispatchEvent(new CompositionEvent("compositionupdate", { data: step, bubbles: true }));
        composing(step);
      }
      area.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
    });

    // Exactly one frame, carrying the syllable: not three jamo (the reported bug) and not the
    // syllable twice (what a naive fix produces, because xterm ALSO finalises the composition).
    await expect.poll(async () => (await sentInputs()).length, { timeout: 15_000 }).toBeGreaterThan(beforeCount);
    await page.waitForTimeout(700);
    const added = (await sentInputs()).slice(beforeCount);
    expect(added, `frames the composition produced: ${JSON.stringify(added)}`).toEqual(["한"]);

    // Leave the prompt clean and the layout as it was.
    await page.keyboard.press("Control+U");
    await writeLayout(request, saved);
  });

  test("[TC-PDTERM-128] a line composed in the input field reaches the shell once", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await page.addInitScript(() => {
      const original = WebSocket.prototype.send;
      const seen: string[] = [];
      (window as unknown as { __pdmuxSent: string[] }).__pdmuxSent = seen;
      WebSocket.prototype.send = function patched(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string") seen.push(data);
        return original.call(this, data);
      };
    });
    await ready(page, "/");
    await showTab(page, "terminal");
    await useOwnSession(page, host.id);
    const pane = page.locator("[data-pdmux-pane]:not([hidden])").first();
    const surface = pane.locator("[data-pdmux-surface]");
    await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 20_000 });
    // The guard is keyboard-only now; a finger lands on the terminal itself.
    const guard = pane.locator("[data-pdmux-surface]");
    if ((await guard.count()) > 0) await guard.tap();

    /**
     * WHY A FIELD AND NOT THE TERMINAL: a mobile IME needs a real input to compose in. In a
     * terminal's hidden textarea, iOS delivered each Korean jamo as finished text, so `한글`
     * arrived as `ㅎ ㅏ ㄴ` (reported, twice). Composing here is the platform's own path;
     * this spec locks the seam between that field and the PTY.
     */
    const composer = page.locator("[data-testid='terminal-composer-input']");
    await expect(composer).toBeVisible();
    await expectOnScreen(composer, "composer input");
    // 16px or the phone zooms the whole shell when this is focused.
    expect(await composer.evaluate((el) => Math.round(parseFloat(getComputedStyle(el).fontSize)))).toBeGreaterThanOrEqual(16);

    const sentInputs = async (): Promise<string[]> =>
      page.evaluate(() => {
        const frames = (window as unknown as { __pdmuxSent?: string[] }).__pdmuxSent ?? [];
        return frames
          .map((raw) => {
            try {
              return JSON.parse(raw) as { type?: string; data?: string };
            } catch {
              return null;
            }
          })
          .filter((frame): frame is { type: string; data: string } => frame?.type === "input" && typeof frame.data === "string")
          .map((frame) => frame.data);
      });

    const before = (await sentInputs()).length;
    await composer.fill("echo 한글");
    await composer.press("Enter");

    // One frame, the whole line, with the carriage return a shell needs — and the field is
    // cleared so the next line starts empty.
    await expect.poll(async () => (await sentInputs()).length, { timeout: 10_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(400);
    expect((await sentInputs()).slice(before)).toEqual(["echo 한글\r"]);
    await expect(composer).toHaveValue("");

    // …and the shell ran it: the syllables survive the round trip intact.
    await expect
      .poll(async () => (await surface.innerText()).replace(/\s+/g, ""), { timeout: 15_000 })
      .toContain("한글");

    await writeLayout(request, saved);
  });

  test("[TC-PDTERM-131] the composer is there before the first tap, and never on a desktop pane", async ({
    page,
    browser,
    request,
  }) => {
    const host = await paneHost(request);
    test.skip(!host, "no host in the fleet — nothing to put in a cell");
    if (!host) return;

    const saved = await readLayout(request);
    /**
     * The state a phone actually opens in: one terminal in the first cell and NOTHING
     * focused. Seeded through the API rather than by driving the picker, because the claim is
     * about a screen nobody has touched — every tap the setup spends is a tap that could be
     * the thing making the composer appear. `pdmux-e2e` is this suite's own session, so
     * nothing here can land in somebody's work.
     */
    await writeLayout(request, {
      name: saved?.name ?? "default",
      payload: {
        mode: "split4",
        page: 0,
        slots: [{ id: "s1", hostId: host.id, kind: "new", session: OWN_SESSION }],
        focusId: null,
        zoomId: null,
      },
      isDefault: true,
    });
    await ready(page, "/");

    // No tap, no swipe, no tab: a phone opens on the terminal view by itself.
    await expect(page.locator("[data-testid='dashboard-shell']")).toHaveAttribute("data-view", "terminal");
    const pane = page.locator("[data-pdmux-pane]:not([hidden])");
    await expect(pane).toHaveCount(1);
    /**
     * …and that pane is NOT focused. That is the state the defect was reported in: the
     * composer required `focused || zoomed`, nothing is focused on a phone until a finger
     * lands, so the ONLY way to type Korean/Japanese/Chinese (pdmux-work/docs/IME_INPUT.md) was hidden
     * behind a tap on a pane the user had no reason to think was inert. Chrome's device
     * emulation never showed it, because its pane came up focused.
     */
    await expect(pane).toHaveAttribute("data-pdmux-focused", "false");
    await expect(pane.locator("[data-pdmux-guard]")).toHaveCount(1);

    const composer = page.locator("[data-testid='terminal-composer-input']");
    await expect(composer).toBeVisible();
    await expectOnScreen(composer, "composer input before any tap");
    await expect(page.locator("[data-testid='terminal-keys']")).toBeVisible();
    // ONE field, not one per mounted pane: a pane that scrolled off the page stays mounted
    // (that is what keeps its session), and a hidden second input field is still a field.
    await expect(page.locator("[data-testid='terminal-composer']")).toHaveCount(1);

    /**
     * The guard is still there and still the thing a finger lands on (asserted above): the
     * composer appearing early must not cost the tap that hands the terminal its focus, which
     * is the only way a software keyboard opens. The live gesture — tap, xterm textarea
     * focused, keys reaching the PTY — is TC-PDTERM-126, and `surface.focus()` inside that
     * gesture is locked without a browser by TC-PDTERM-131 in packages/ui. It cannot be
     * re-asserted here, because an unreachable pane's "not reachable" overlay covers its own
     * guard, and this spec deliberately runs without requiring an attached agent.
     */

    /**
     * The SAME layout on a desktop: a pointer-fine screen with a pane merely visible must not
     * grow a composer. `keyBar` is `(pointer: coarse)` and that is the whole gate, which is
     * why relaxing the focus test above cannot leak onto a desktop. A fresh context rather
     * than a resize: the media query is the device's, not the viewport's.
     */
    const desktop = await browser.newContext({
      storageState: e2eAdminState,
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5001",
      viewport: { width: 1280, height: 900 },
    });
    try {
      const wide = await desktop.newPage();
      await ready(wide, "/");
      const cells = wide.locator("[data-pdmux-cell]:not([hidden])");
      expect(await cells.count(), "a desktop shows the user's split, not one cell").toBeGreaterThan(1);
      await expect(wide.locator("[data-pdmux-pane]:not([hidden])")).toHaveCount(1);
      expect(
        await wide.locator("[data-testid='terminal-composer']").count(),
        "a desktop pane that is merely visible grew a composer",
      ).toBe(0);
      expect(await wide.locator("[data-testid='terminal-keys']").count()).toBe(0);
    } finally {
      await desktop.close();
    }

    await writeLayout(request, saved);
  });

  test("[TC-PDUI-156] the shell yields to the software keyboard", async ({ page }) => {
    await ready(page, "/");
    await showTab(page, "terminal");

    // No headless engine can raise a real keyboard, so the CSS contract is driven directly:
    // the app sets these two from `visualViewport`, and this asserts what they must produce.
    await page.evaluate(() => {
      const shell = document.querySelector(".pdmux-shell") as HTMLElement;
      shell.style.setProperty("--pdmux-vh", "440px");
      shell.dataset.keyboard = "open";
    });

    const facts = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return { h: Math.round(rect?.height ?? 0), bottom: Math.round(rect?.bottom ?? 0) };
      };
      return { shell: box(".pdmux-shell"), tabs: box("[data-testid='shell-tabs']"), grid: box("[data-pdmux-grid]") };
    });

    expect(facts.shell.h, "the shell must take the visible height, not the layout one").toBe(440);
    // The tab bar is navigation nobody is doing while typing, and those 48px are the ones
    // the terminal needs.
    expect(facts.tabs.h, "the tab bar must yield to the keyboard").toBe(0);
    expect(facts.grid.bottom).toBeLessThanOrEqual(440);
    expect(facts.grid.h).toBeGreaterThan(200);
    await expectViewportBound(page);
  });
});
