/**
 * Keyboard geometry. A headless browser cannot raise a software keyboard, so the
 * arithmetic is locked here and the CSS contract is driven from a spec.
 */
import { describe, expect, it } from 'vitest';
import { KEYBOARD_MIN_PX, keyboardInset } from '../src/viewport.js';

describe('[TC-PDCORE-083] the software keyboard is inferred from the visual viewport', () => {
	it('ignores browser chrome and reports a keyboard', () => {
		// A phone at rest: both viewports agree.
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 844 })).toEqual({
			open: false,
			keyboard: 0,
			height: 844,
		});

		// Mobile Safari's collapsing toolbar moves this by ~40-60px. Resizing the shell for
		// that would make it jitter while a list is scrolled.
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 790 }).open).toBe(false);
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 844 - (KEYBOARD_MIN_PX - 1) }).open).toBe(false);

		// A keyboard is never that small.
		const typing = keyboardInset({ layoutHeight: 844, viewportHeight: 508 });
		expect(typing).toEqual({ open: true, keyboard: 336, height: 508 });
	});

	it('subtracts the offset iOS introduces when it scrolls the visual viewport', () => {
		// Safari scrolls the visual viewport inside the layout one to reveal what it
		// focused; without subtracting that the keyboard reads as smaller than it is.
		const scrolled = keyboardInset({ layoutHeight: 844, viewportHeight: 508, offsetTop: 60 });
		expect(scrolled.keyboard).toBe(276);
		expect(scrolled.open).toBe(true);
	});

	it('never produces a shell with no height', () => {
		// A blank screen is worse than a shell that ignores one bad sample, so junk falls
		// back to the layout height rather than NaN.
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: Number.NaN }).height).toBe(844);
		expect(keyboardInset({ layoutHeight: Number.NaN, viewportHeight: 500 }).height).toBe(0);
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: -10 }).open).toBe(false);
		expect(keyboardInset({ layoutHeight: 844, viewportHeight: 0 }).open).toBe(false);
	});
});
