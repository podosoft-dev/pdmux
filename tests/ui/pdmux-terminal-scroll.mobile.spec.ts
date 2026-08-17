import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { ready } from "../helpers/hydration";
import { e2eAdminState } from "../helpers/accounts";
import { readLayout, seedSoloPane, writeLayout } from "../helpers/pdmux-layout";

/**
 * Reaching the output that scrolled off the top of a pane, from a phone.
 *
 * TWO REPORTS, ONE SUBJECT. "There is no scrollbar on a terminal pane" and "on mobile you
 * cannot scroll back at all" — and the reason they are one file is that both answers depend on
 * WHICH BUFFER the pane is in, which is not visible from the outside:
 *
 *  - a `shell` pane is xterm's NORMAL buffer. `scrollback: 5000` is real there, the viewport is
 *    a scroll container, and xterm's own touch handling already moved it.
 *  - a `session` pane runs `tmux new -A -s <name>`, i.e. the ALTERNATE buffer, where xterm
 *    keeps no scrollback whatsoever (`BufferSet.ts:44`). Nothing can scroll, nothing can draw a
 *    thumb, and the history the user wants belongs to tmux. A wheel is translated into cursor
 *    keys for the program; a finger used to be translated into nothing.
 *
 * So each case below states its buffer, and the two are asserted differently on purpose.
 *
 * ENGINE: the drags are dispatched over CDP, which is Chromium-only, so `ui-mobile-webkit`
 * skips them. The gesture logic itself is engine-independent and pinned offline in
 * `packages/ui/test/terminal-scroll.test.ts`; what only a real engine can answer — whether
 * xterm's own handler cancels the move first, and whether the platform tints its overlay
 * scrollbar — is what these two specs are here for.
 */

interface HostRow {
  id: string;
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
 * Drag one finger down the middle of the terminal, in steps a phone would produce.
 *
 * ⚠ CDP RATHER THAN A SYNTHETIC EVENT, and slowly. `Input.dispatchTouchEvent` produces trusted
 * touches that hit-test like a real finger, which is the only way to find out whether something
 * ELSE on the page takes the gesture first. The 20ms between moves is not cosmetic: with no
 * pause Blink coalesces the moves and a drag that should be worth eight rows arrives as one or
 * two (measured — the first attempt at this drag moved nothing at all for that reason).
 *
 * Downward, because that is the direction that asks for EARLIER output, the same as a wheel
 * scrolled up.
 */
async function dragDown(page: Page, steps = 10, pitch = 14): Promise<void> {
  const surface = page.locator("[data-pdmux-surface]").first();
  const box = await surface.boundingBox();
  if (!box) throw new Error("the pane has no box to drag on");
  const x = Math.round(box.x + box.width / 2);
  // A third of the way down, so ten 14px steps stay inside the surface.
  const top = Math.round(box.y + box.height / 3);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: top }] });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: top + step * pitch }] });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Everything the page has sent up the socket, as the protocol's own `input` frames. */
async function sentInputs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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
}

async function recordSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = WebSocket.prototype.send;
    const seen: string[] = [];
    (window as unknown as { __pdmuxSent: string[] }).__pdmuxSent = seen;
    WebSocket.prototype.send = function patched(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      if (typeof data === "string") seen.push(data);
      return original.call(this, data);
    };
  });
}

// Its own account, host and agent: these specs write the dashboard layout, and sharing an
// account with a person rearranges their screen mid-session.
test.use({ storageState: e2eAdminState });

test.describe("reaching a pane's scrollback from a phone", () => {
  test("[TC-PDTERM-129] a pane with history behind it shows this product's own thumb", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    try {
      // A SHELL pane, because it is the one that has xterm scrollback at all.
      await seedSoloPane(request, saved, { id: "scroll1", hostId: host.id, kind: "shell", session: null });
      await ready(page, "/");
      const surface = page.locator("[data-pdmux-surface]").first();
      await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      const viewport = surface.locator(".xterm-viewport");

      // Nothing to scroll yet: no thumb is painted while the box is not scrollable, which is
      // what makes a thumb MEAN "there is history here" rather than being permanent furniture.
      expect(await viewport.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight)).toBe(0);

      // 500 lines of real output, typed the way a phone types.
      const composer = page.locator("[data-testid='terminal-composer-input']");
      await expect(composer).toBeVisible();
      await composer.fill("seq 1 500");
      await composer.press("Enter");
      await expect
        .poll(async () => viewport.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight), {
          timeout: 25_000,
          message: "the shell pane never became scrollable, so there is no scrollback to show",
        })
        .toBeGreaterThan(0);

      const facts = await viewport.evaluate((el: HTMLElement) => {
        const style = getComputedStyle(el);
        const screen = el.parentElement?.querySelector(".xterm-screen") as HTMLElement | null;
        const xterm = el.closest(".xterm") as HTMLElement | null;
        return {
          overflowY: style.overflowY,
          scrollbarColor: style.scrollbarColor,
          scrollbarWidth: style.scrollbarWidth,
          thumb: getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
          track: getComputedStyle(el, "::-webkit-scrollbar-track").backgroundColor,
          // The strip along the right edge that xterm keeps free of glyphs.
          reserved: xterm && screen ? xterm.offsetWidth - screen.offsetWidth : 0,
        };
      });

      /**
       * WHAT IS ASSERTED AND WHY IT IS NOT A WIDTH: on this engine the scrollbar takes NO
       * layout — `offsetWidth - clientWidth` measured 0 on the Pixel 7 and 0 on desktop
       * Chromium, with `::-webkit-scrollbar` declared and without it. It is an overlay, and
       * what decides whether the user sees this product's grey or the engine's default is
       * `scrollbar-color`, which Blink does honour. So the colour IS the fix here.
       */
      expect(facts.overflowY).toBe("scroll");
      expect(facts.scrollbarColor, "the terminal thumb is no longer the product's grey").toBe(
        "rgb(182, 189, 201) rgba(0, 0, 0, 0)",
      );
      expect(facts.scrollbarWidth).toBe("thin");
      // The classic-scrollbar path, for a platform that does lay one out. Same grey.
      expect(facts.thumb).toBe("rgb(182, 189, 201)");
      // …over a track nobody painted, so an idle pane keeps its surface.
      expect(facts.track).toBe("rgba(0, 0, 0, 0)");
      // And there is room for the 10px thumb outside the glyphs (measured 19px here).
      expect(facts.reserved, "xterm stopped reserving a strip, so a thumb would cover text").toBeGreaterThanOrEqual(10);
    } finally {
      await writeLayout(request, saved);
    }
  });

  test("[TC-PDTERM-130] a finger reaches back through both kinds of pane", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "the drag is dispatched over CDP; WebKit is covered by the unit spec");
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await recordSocket(page);
    try {
      // --- the NORMAL buffer: xterm's own scrollback, which xterm must keep scrolling -------
      await seedSoloPane(request, saved, { id: "scroll2", hostId: host.id, kind: "shell", session: null });
      await ready(page, "/");
      const surface = page.locator("[data-pdmux-surface]").first();
      await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      const viewport = surface.locator(".xterm-viewport");
      await page.locator("[data-testid='terminal-composer-input']").fill("seq 1 500");
      await page.locator("[data-testid='terminal-composer-input']").press("Enter");
      await expect
        .poll(async () => viewport.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight), { timeout: 25_000 })
        .toBeGreaterThan(0);
      // Output pins the view to the bottom, which is where a person starts reading back from.
      const bottom = await viewport.evaluate((el: HTMLElement) => el.scrollTop);
      expect(bottom).toBeGreaterThan(0);

      const beforeShellDrag = (await sentInputs(page)).length;
      await dragDown(page);
      // The finger moved the view towards earlier output…
      await expect
        .poll(async () => viewport.evaluate((el: HTMLElement) => el.scrollTop), {
          timeout: 5_000,
          message: "a drag on a shell pane no longer reaches its scrollback",
        })
        .toBeLessThan(bottom);
      // …and nothing was typed at the shell doing it. This is the guard against a second
      // scroller: xterm already handles this buffer, and translating the drag into keys here
      // as well would both scroll AND send arrows to whatever is running.
      expect(
        (await sentInputs(page)).slice(beforeShellDrag),
        "a drag on a scrollable pane sent keystrokes as well as scrolling",
      ).toEqual([]);

      // --- the ALTERNATE buffer: tmux, where xterm has no scrollback to scroll -------------
      await seedSoloPane(request, saved, { id: "scroll3", hostId: host.id, kind: "new", session: "pdmux-e2e" });
      await page.reload();
      await ready(page, "/");
      const tmux = page.locator("[data-pdmux-surface]").first();
      await expect(tmux.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      const tmuxViewport = tmux.locator(".xterm-viewport");
      // The premise, asserted rather than assumed: there is nothing here for a viewport
      // scroll — or a scrollbar — to move. Polled because the pane re-fits as it attaches.
      await expect
        .poll(async () => tmuxViewport.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight), {
          timeout: 20_000,
          message: "this pane has xterm scrollback, so it is not the alternate-buffer case",
        })
        .toBe(0);

      // A tap must stay a tap: it is what raises the software keyboard.
      const beforeTap = (await sentInputs(page)).length;
      await tmux.tap();
      await page.waitForTimeout(300);
      expect((await sentInputs(page)).slice(beforeTap), "a tap was turned into keystrokes").toEqual([]);

      // A horizontal drag belongs to the browser's back gesture — which on a phone IS this
      // app's view navigation (`mobile-view.svelte.ts` puts each view in history on purpose).
      // There is no in-app swipe handler to compete with; the axis lock is protecting the
      // platform's own gesture.
      const beforeSwipe = (await sentInputs(page)).length;
      const box = await tmux.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const y = Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);
      const x0 = Math.round((box?.x ?? 0) + 30);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
      for (let step = 1; step <= 8; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + step * 20, y }] });
        await page.waitForTimeout(20);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await page.waitForTimeout(300);
      expect((await sentInputs(page)).slice(beforeSwipe), "a sideways swipe was read as a scroll").toEqual([]);

      // …and the vertical drag reaches the history the way the wheel does: xterm converts a
      // wheel over this buffer into cursor keys for the program (measured on this pane:
      // `ESC O A` three times for one notch), and the finger now says the same thing.
      const beforeDrag = (await sentInputs(page)).length;
      await dragDown(page);
      await expect
        .poll(async () => (await sentInputs(page)).slice(beforeDrag).length, {
          timeout: 5_000,
          message: "a drag on a tmux pane still reaches nothing",
        })
        .toBeGreaterThan(0);
      const sent = (await sentInputs(page)).slice(beforeDrag).join("");
      expect(sent, `frames the drag produced: ${JSON.stringify(sent)}`).toMatch(/^(\u001b(\[|O)A)+$/);
      // Bounded: a 140px drag is worth about ten rows, not a hundred keypresses.
      expect(sent.length / 3).toBeLessThanOrEqual(20);
    } finally {
      await writeLayout(request, saved);
    }
  });

  /**
   * THE CASE THE REPORT WAS ABOUT, and the only one a real engine can settle.
   *
   * A pane running a coding agent is in the alternate buffer AND has mouse reporting on, and
   * there xterm skips its own scrollback and cursor-key fallbacks outright (`if
   * (requestedEvents.wheel) return`) to encode a report for the program instead. The finger used
   * to stand down in that mode, mirroring xterm's own touch bail — so from a phone there was NO
   * gesture at all on exactly the panes this product exists to watch, while a desktop wheel
   * worked. Reported from an iPhone against a deployed dashboard.
   *
   * ⚠ A CODING AGENT IS NOT REQUIRED TO REPRODUCE IT, WHICH IS WHY THIS SPEC EXISTS. `mouse on`
   * puts a multiplexer in the same mode, so the fleet's own session can prove it. The option is
   * set WITHOUT `-g` on purpose: a global one belongs to the whole tmux server, and other
   * people's sessions live there.
   *
   * ⚠ AND IN A SESSION OF ITS OWN, WHICH COST A RED RUN TO LEARN. Written against the shared
   * `pdmux-e2e` session, this left `mouse on` behind — the teardown types the option back off
   * through the pane and it does not always land — and the NEXT test in this serial file
   * (`[TC-PDTERM-135]`, which asserts the buttons send cursor keys) got thirteen
   * `ESC[<64;24;19M` mouse reports instead. A test that arms the terminal differently has to own
   * the terminal it arms.
   */
  test("[TC-PDTERM-130] a finger reaches a program that captured the mouse", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "the drag is dispatched over CDP; WebKit is covered by the unit spec");
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await recordSocket(page);
    try {
      await seedSoloPane(request, saved, { id: "scroll5", hostId: host.id, kind: "new", session: "pdmux-e2e-mouse" });
      await ready(page, "/");
      const surface = page.locator("[data-pdmux-surface]").first();
      await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      /**
       * ⚠ WAIT FOR OUTPUT, NOT FOR THE ELEMENT. `.xterm-rows` exists the moment the pane mounts,
       * and `scrollHeight === clientHeight` is true of an EMPTY pane as well as an attached
       * multiplexer — so both are satisfied before the socket has opened the PTY, and a line
       * typed then is dropped for good ("input typed while the relay is away is genuinely lost",
       * `terminal-relay.ts`). Measured: with only those checks this spec failed on a cold session
       * and passed on the retry, which is the shape of a race, not of a slow machine.
       *
       * Painted text is the round trip actually completing.
       */
      await expect
        .poll(async () => (await surface.locator(".xterm-rows").innerText()).trim().length, {
          timeout: 30_000,
          message: "the pane never printed anything, so the multiplexer is not attached yet",
        })
        .toBeGreaterThan(0);

      const composer = page.locator("[data-testid='terminal-composer-input']");
      await expect(composer).toBeVisible();
      /**
       * ⚠ THE STARTING STATE IS NOT ASSERTED, AND THAT IS DELIBERATE. `mouse` is a SESSION option
       * that outlives the run which set it, so the obvious guard — "it is off before we arm it" —
       * has to be established rather than assumed. Turning it off and waiting was tried and
       * MEASURED NOT TO WORK: with the pane already armed, `tmux set mouse off` did not clear
       * xterm's `enable-mouse-events` within 20s, so the spec went red on a dirty session and
       * green on a clean one — a coin toss, not a test.
       *
       * It is not needed either. What is under test is that a DRAG reaches a program holding the
       * mouse, and the SGR frames below cannot appear unless mouse reporting is really active on
       * this pane. Nothing else in this file uses this session, so nothing else can be misled by
       * what it leaves behind.
       */
      await composer.fill("tmux set mouse on");
      await composer.press("Enter");
      // xterm's own signal that the program asked for the pointer: `areMouseEventsActive` puts
      // this class on the element. Waiting for the state rather than for a delay is what keeps
      // this from passing for the wrong reason on a slow relay.
      await expect(surface.locator(".xterm.enable-mouse-events")).toBeVisible({ timeout: 20_000 });

      const before = (await sentInputs(page)).length;
      await dragDown(page);
      await expect
        .poll(async () => (await sentInputs(page)).slice(before).length, {
          timeout: 5_000,
          message: "a drag on a mouse-capturing pane still reaches nothing — the old stand-down is back",
        })
        .toBeGreaterThan(0);
      const sent = (await sentInputs(page)).slice(before).join("");
      /**
       * SGR (1006) wheel reports, which is what the drag has to become here — 64 is wheel-up, at
       * a cell the pane actually has. Cursor keys would mean this code is translating again
       * instead of handing the event over, and nothing at all would be the reported bug.
       */
      expect(sent, `frames the drag produced: ${JSON.stringify(sent)}`).toMatch(/^(\x1b\[<64;\d+;\d+M)+$/);
    } finally {
      // Leave the session as it was found — and CONFIRM it, because typing into a pane that is
      // about to be torn down is not a guarantee. The start of the test repairs what this misses.
      const composer = page.locator("[data-testid='terminal-composer-input']");
      if (await composer.isVisible().catch(() => false)) {
        await composer.fill("tmux set mouse off").catch(() => undefined);
        await composer.press("Enter").catch(() => undefined);
        await expect(page.locator("[data-pdmux-surface]").first().locator(".xterm.enable-mouse-events"))
          .toHaveCount(0, { timeout: 10_000 })
          .catch(() => undefined);
      }
      await writeLayout(request, saved);
    }
  });

  /**
   * THE PRICE OF DROPPING THE OLD `alternate` GUARD, pinned.
   *
   * The handler no longer asks which buffer it is in; it asks whether anybody else consumed the
   * move. At the very top of a shell pane's scrollback xterm has nothing left to scroll, so it
   * stops cancelling — and the drag falls through to a wheel. That is only harmless because
   * `scrollback: 5000` keeps xterm's `hasScrollback` true on the normal buffer, which sends the
   * wheel to the viewport rather than down the socket as a cursor key. Lower that number and
   * this spec turns red, with shell history being recalled at a prompt.
   */
  test("[TC-PDTERM-130] a drag past the top of the scrollback still types nothing", async ({
    page,
    request,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the drag is dispatched over CDP; WebKit is covered by the unit spec");
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await recordSocket(page);
    try {
      await seedSoloPane(request, saved, { id: "scroll6", hostId: host.id, kind: "shell", session: null });
      await ready(page, "/");
      const surface = page.locator("[data-pdmux-surface]").first();
      await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      const viewport = surface.locator(".xterm-viewport");
      const composer = page.locator("[data-testid='terminal-composer-input']");
      await composer.fill("seq 1 500");
      await composer.press("Enter");
      await expect
        .poll(async () => viewport.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight), { timeout: 25_000 })
        .toBeGreaterThan(0);

      // Jump to the oldest line rather than dragging there — the point is the boundary, not the
      // journey, and ten drags would only make this slower.
      await viewport.evaluate((el: HTMLElement) => {
        el.scrollTop = 0;
      });
      const before = (await sentInputs(page)).length;
      await dragDown(page);
      await page.waitForTimeout(300);
      expect(await viewport.evaluate((el: HTMLElement) => el.scrollTop)).toBe(0);
      expect(
        (await sentInputs(page)).slice(before),
        "a drag at the top of the scrollback typed at the shell instead of doing nothing",
      ).toEqual([]);
    } finally {
      await writeLayout(request, saved);
    }
  });

  /**
   * The two buttons at the end of the key row — the deliberate half of the same feature: a
   * drag is a wheel you have to aim, and these are the wheel you can tap.
   *
   * REPORTED FROM A PHONE: "they do not work, and they disappear the moment I press them."
   * Both halves came from `canScroll` being read only from inside the press it gated, so on a
   * multiplexer pane the buttons were drawn, ignored, and then latched off for good. The bytes
   * below are the fix: the button hands xterm a WHEEL EVENT and lets it route it, which is the
   * only gesture that reaches all of the programs these panes hold — a full-screen program
   * that captures the mouse scrolls its own transcript from the wheel and ignores PageUp
   * entirely, and only the wheel is common to that, to `vim`, and to a plain shell.
   */
  test("[TC-PDTERM-135] the scroll buttons reach a multiplexer pane, and outlive the press", async ({ page, request }) => {
    const host = await onlineHost(request);
    test.skip(!host, "no online host — start an agent to exercise the terminal relay");
    if (!host) return;
    test.slow();

    const saved = await readLayout(request);
    await recordSocket(page);
    try {
      // The ALTERNATE buffer, which is what nearly every pane on this dashboard is showing.
      await seedSoloPane(request, saved, { id: "scroll4", hostId: host.id, kind: "new", session: "pdmux-e2e" });
      await ready(page, "/");
      const surface = page.locator("[data-pdmux-surface]").first();
      await expect(surface.locator(".xterm-rows")).toBeVisible({ timeout: 30_000 });
      // The premise, asserted rather than assumed: xterm has no scrollback of its own here, so
      // the old implementation's `term.scrollPages()` was a no-op by construction.
      await expect
        .poll(
          async () =>
            surface.locator(".xterm-viewport").evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight),
          { timeout: 20_000, message: "this pane has xterm scrollback, so it is not the alternate-buffer case" },
        )
        .toBe(0);

      const up = page.locator("[data-testid='terminal-scroll-up']");
      const down = page.locator("[data-testid='terminal-scroll-down']");
      // Drawn because a wheel DOES reach this pane — not because a seeded `true` had yet to be
      // corrected, which is what used to put them here.
      await expect(up).toBeVisible();
      await expect(down).toBeVisible();

      const before = (await sentInputs(page)).length;
      await up.tap();
      await expect
        .poll(async () => (await sentInputs(page)).slice(before).length, {
          timeout: 5_000,
          message: "the scroll button still reaches nothing on a multiplexer pane",
        })
        .toBeGreaterThan(0);

      // Exactly what a wheel over this pane produces and nothing else: with no scrollback to
      // move, xterm converts one into cursor keys for the program. Measured, not assumed.
      const sentUp = (await sentInputs(page)).slice(before).join("");
      expect(sentUp, `frames the press produced: ${JSON.stringify(sentUp)}`).toMatch(/^(\u001b(\[|O)A)+$/);
      // A page, not a hundred keypresses — a phone pane is a few tens of rows.
      expect(sentUp.length / 3).toBeLessThanOrEqual(60);

      // ⚠ AND BOTH ARE STILL THERE. The second half of the report: the press used to take them
      // with it, and nothing short of remounting the pane brought them back.
      await expect(up, "the press took the scroll buttons with it").toBeVisible();
      await expect(down, "the press took the scroll buttons with it").toBeVisible();
      // Nor did it close the software keyboard — every control on this row answers
      // `pointerdown` and prevents the default precisely so focus never leaves the terminal.
      expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");

      const beforeDown = (await sentInputs(page)).length;
      await down.tap();
      await expect
        .poll(async () => (await sentInputs(page)).slice(beforeDown).length, { timeout: 5_000 })
        .toBeGreaterThan(0);
      const sentDown = (await sentInputs(page)).slice(beforeDown).join("");
      expect(sentDown, `frames the press produced: ${JSON.stringify(sentDown)}`).toMatch(/^(\u001b(\[|O)B)+$/);
    } finally {
      await writeLayout(request, saved);
    }
  });
});
