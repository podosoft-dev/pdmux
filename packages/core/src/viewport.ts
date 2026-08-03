/**
 * The software keyboard, inferred from the visual viewport.
 *
 * WHY NOT `dvh`: on iOS the keyboard does not touch the layout viewport at all —
 * `100dvh`, `innerHeight` and `documentElement.clientHeight` read the same before and
 * after it appears, while `visualViewport.height` shrinks. Android Chrome's default is
 * the same (`interactive-widget=resizes-visual`). A shell sized in `dvh` therefore keeps
 * its bottom half — the terminal's last rows and the helper row — underneath the
 * keyboard, which is exactly where a person is looking while typing.
 *
 * Pure and framework-free: the browser events live in the app, the arithmetic lives here
 * where it can be tested without a phone.
 */

/**
 * Below this, the change is the browser's own chrome, not a keyboard.
 *
 * Mobile Safari's collapsing toolbars move the same number by roughly 40-60px, and a
 * shell that resized for those would jitter while a list is scrolled. No keyboard is
 * that small.
 */
export const KEYBOARD_MIN_PX = 120;

/** What the app reads off `window` / `visualViewport`. */
export interface ViewportSample {
	/** `documentElement.clientHeight` — the layout viewport, which the keyboard ignores. */
	layoutHeight: number;
	/** `visualViewport.height` — what the user can actually see. */
	viewportHeight: number;
	/** `visualViewport.offsetTop` — how far the visual viewport is scrolled inside the layout one. */
	offsetTop?: number;
}

export interface KeyboardInset {
	open: boolean;
	/** Height the shell should take: the visible area while a keyboard is up. */
	height: number;
	/** How much of the screen the keyboard covers, 0 when closed. */
	keyboard: number;
}

const finite = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Resolve a sample into "is a keyboard up, and how tall is the shell".
 *
 * Junk in (NaN, undefined, a negative height) resolves to the layout height rather than
 * throwing or producing `NaN` — a shell with no height is a blank screen, which is worse
 * than a shell that ignores one bad sample.
 */
export function keyboardInset(sample: ViewportSample, minPx: number = KEYBOARD_MIN_PX): KeyboardInset {
	const layout = Math.max(0, finite(sample?.layoutHeight, 0));
	const visual = Math.max(0, finite(sample?.viewportHeight, layout));
	const offset = Math.max(0, finite(sample?.offsetTop, 0));
	const keyboard = Math.max(0, Math.round(layout - visual - offset));
	const threshold = Math.max(0, finite(minPx, KEYBOARD_MIN_PX));
	const open = keyboard >= threshold && visual > 0;
	return { open, keyboard: open ? keyboard : 0, height: open ? Math.round(visual) : Math.round(layout) };
}
