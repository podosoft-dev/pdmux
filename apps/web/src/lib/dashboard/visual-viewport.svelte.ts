/**
 * The software keyboard, watched.
 *
 * WHY THE APP AND NOT `@pdmux/ui`: this reads `window` and adds listeners, and the package
 * takes props and touches no globals — that boundary is what lets its components be
 * installed elsewhere. The package only *consumes* `--pdmux-vh` with a `100dvh` fallback,
 * so a consumer that never wires a sensor behaves exactly as before.
 *
 * The arithmetic lives in `@pdmux/core` (`keyboardInset`) where it is unit-tested without
 * a phone; this file is only the plumbing.
 */
import { type KeyboardInset, keyboardInset } from "@pdmux/core";

export interface KeyboardWatcher {
  readonly open: boolean;
  /** Height the shell should take, in px. */
  readonly height: number;
  /** How much of the screen the keyboard covers, 0 when closed. */
  readonly keyboard: number;
}

/**
 * Track the visual viewport for as long as the calling component lives.
 *
 * Must be called during component initialisation — it owns an `$effect`.
 */
export function trackVisualViewport(): KeyboardWatcher {
  let inset = $state<KeyboardInset>({ open: false, height: 0, keyboard: 0 });

  $effect(() => {
    const vv = window.visualViewport;
    // No sensor (an old browser, a headless run): the stylesheet's `100dvh` is correct and
    // reporting `open: false` keeps every existing height assertion true.
    if (!vv) return;

    const read = (): void => {
      // ⚠ Use the local value below, never `inset`. Reading the state this effect writes
      // makes the effect depend on itself, and Svelte answers with
      // `effect_update_depth_exceeded` — measured: the whole shell stopped updating and a
      // tab tap did nothing at all.
      const next = keyboardInset({
        layoutHeight: document.documentElement.clientHeight,
        viewportHeight: vv.height,
        offsetTop: vv.offsetTop,
      });
      inset = next;
      // Mobile Safari scrolls the LAYOUT viewport to reveal whatever it focused. Once the
      // shell has resized to the visible area there is nothing left to reveal, and a
      // scrolled layout viewport is exactly the "the page scrolls" failure the geometry
      // helpers exist to catch (ARCHITECTURE §7).
      if (next.open && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    /**
     * ⚠ AND ONCE MORE WHEN THE TAB COMES BACK. A phone freezes a backgrounded tab, and iOS may
     * restore it from the page cache without firing either event above — so a shell that was
     * suspended with the keyboard open keeps the keyboard's height in `--pdmux-vh` and stays
     * short after the keyboard is long gone. This is the round trip the operator makes every
     * day: give a coding agent an instruction, lock the phone, come back hours later.
     *
     * `pageshow` covers the page-cache restore and `visibilitychange` the ordinary return.
     * Re-reading is cheap and idempotent — it is the same function the sensor calls.
     */
    const reread = (): void => {
      if (document.visibilityState === "visible") read();
    };
    window.addEventListener("pageshow", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
      window.removeEventListener("pageshow", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  });

  return {
    get open() {
      return inset.open;
    },
    get height() {
      return inset.height;
    },
    get keyboard() {
      return inset.keyboard;
    },
  };
}
