import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { HELPER_KEY_SETS } from '@pdmux/core';
import TerminalKeyBar from '../src/components/TerminalKeyBar.svelte';

/**
 * ⚠ EVERY CONTROL ON THIS ROW MUST ANSWER `pointerdown`, NOT `click`, AND CARRY
 * `tabindex="-1"`.
 *
 * A button that takes focus takes it FROM the terminal's hidden textarea, and both iOS and
 * Android close the software keyboard the instant the focused element stops being editable
 * — the row would dismiss the very keyboard it exists to serve. This is the contract the
 * whole feature rests on, so it is asserted on every control rather than sampled.
 */
function firePointerDown(el: Element): boolean {
	const event = new Event('pointerdown', { bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

/** Turn the row to the next set. */
const turn = (container: HTMLElement): boolean =>
	firePointerDown(container.querySelector('[data-pdmux-keyset-next]') as HTMLElement);

const showing = (container: HTMLElement): string =>
	(container.querySelector('[data-pdmux-keys]') as HTMLElement).dataset.pdmuxKeyset ?? '';

const faces = (container: HTMLElement): string[] =>
	[...container.querySelectorAll('[data-pdmux-key]')].map((el) => el.getAttribute('data-pdmux-key') ?? '');

describe('[TC-PDUI-178] the key row offers the panel and scrolling without stealing focus', () => {
	it('sends a key on pointerdown and prevents the default', () => {
		const onKey = vi.fn();
		const { container } = render(TerminalKeyBar, { props: { onKey } });
		const esc = container.querySelector('[data-pdmux-key="esc"]') as HTMLElement;
		expect(firePointerDown(esc), 'the press did not preventDefault — the keyboard will close').toBe(true);
		expect(onKey).toHaveBeenCalledWith('esc');
	});

	it('never lets any control take focus', async () => {
		const { container } = render(TerminalKeyBar, { props: {} });
		// Walked, because a set that is not showing has no buttons to check — and the sets
		// that appear only after a page turn are exactly the ones nobody looks at by hand.
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			const controls = [...container.querySelectorAll('button')];
			expect(controls.length).toBeGreaterThan(0);
			for (const control of controls) {
				expect(control.getAttribute('tabindex'), `${control.dataset.testid} is focusable`).toBe('-1');
			}
			expect(turn(container), 'the page turn did not preventDefault').toBe(true);
		}
	});

	it('turns the page from a trigger that is not itself a key', () => {
		// It carries no `data-pdmux-key`, so nothing can mistake it for one and send it.
		const onKey = vi.fn();
		const { container } = render(TerminalKeyBar, { props: { onKey } });
		const cycle = container.querySelector('[data-pdmux-keyset-next]') as HTMLElement;
		expect(cycle.hasAttribute('data-pdmux-key')).toBe(false);
		expect(firePointerDown(cycle)).toBe(true);
		expect(onKey, 'the page turn sent a key to the terminal').not.toHaveBeenCalled();
	});

	it('scrolls in both directions', () => {
		// A phone had no way to reach scrollback at all: a mouse has a wheel, a finger had
		// nothing, so everything above the fold was unreachable.
		const onScroll = vi.fn();
		const { container } = render(TerminalKeyBar, { props: { onScroll } });
		firePointerDown(container.querySelector('[data-pdmux-scroll="up"]') as HTMLElement);
		firePointerDown(container.querySelector('[data-pdmux-scroll="down"]') as HTMLElement);
		expect(onScroll).toHaveBeenNthCalledWith(1, -1);
		expect(onScroll).toHaveBeenNthCalledWith(2, 1);
	});

	it('hides the scroll buttons when the buffer cannot scroll', () => {
		// A pane attached to a multiplexer runs in the alternate buffer, which keeps no
		// scrollback — a scroll button there would visibly do nothing.
		const { container } = render(TerminalKeyBar, { props: { scrollable: false } });
		expect(container.querySelector('[data-pdmux-scroll]')).toBeNull();
	});

	it('keeps the scroll buttons out of the cycle', async () => {
		// They are the wheel, not one page of a keyboard: a set that swapped them away would
		// take scrolling with it for as long as the row stayed on that page.
		const { container } = render(TerminalKeyBar, { props: {} });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			expect(container.querySelectorAll('[data-pdmux-scroll]'), `set ${showing(container)}`).toHaveLength(2);
			expect(container.querySelector('[data-pdmux-keyset-next]'), 'the page turn vanished').not.toBeNull();
			turn(container);
		}
	});
});

describe('[TC-PDUI-179] the row reaches every key a phone cannot type', () => {
	/**
	 * ⚠ THE ROW IS NOW THE ONLY PATH. This contract used to belong to the popover; deleting
	 * that widget would have deleted the guarantee with it, which is how a feature quietly
	 * loses keys. So it moved here, and it is asserted over the UNION of the sets rather than
	 * over what happens to be on screen.
	 */
	const reachable = async (container: HTMLElement): Promise<Set<string>> => {
		const seen = new Set<string>();
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			// ⚠ FLUSH BEFORE READING. Svelte 5 lands a state change on a microtask, so a turn
			// followed by a synchronous read returns the PREVIOUS set — which made this walk
			// look like it had visited every page while it read the first one N times.
			await tick();
			for (const id of faces(container)) seen.add(id);
			turn(container);
		}
		return seen;
	};

	it('offers Shift+Tab, the editing keys, and the movement keys somewhere in the cycle', async () => {
		const { container } = render(TerminalKeyBar, { props: {} });
		const keys = await reachable(container);
		// `shiftTab` first: a coding agent cycles its modes with it and no software keyboard
		// can produce it — it is the key this whole feature was asked for.
		for (const key of ['shiftTab', 'tab', 'enter', 'backspace', 'delete', 'home', 'end', 'pageUp', 'pageDown']) {
			expect(keys.has(key), `${key} is unreachable from a phone`).toBe(true);
		}
	});

	it('can still interrupt — ^C is reachable', async () => {
		// It is the interrupt. A phone that cannot send it cannot stop a runaway process at
		// all, and this row is the only keyboard it has.
		const { container } = render(TerminalKeyBar, { props: {} });
		expect((await reachable(container)).has('ctrlC'), 'a phone cannot interrupt anything').toBe(true);
	});

	it('sends a chord whole rather than arming anything', async () => {
		// `^C` is one button and one byte: no latch to arm, nothing to half-happen when the
		// next tap goes astray.
		const onKey = vi.fn();
		const { container } = render(TerminalKeyBar, { props: { onKey } });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			const ctrlC = container.querySelector('[data-pdmux-key="ctrlC"]');
			if (ctrlC) {
				expect(firePointerDown(ctrlC)).toBe(true);
				expect(onKey).toHaveBeenCalledWith('ctrlC');
				return;
			}
			turn(container);
		}
		throw new Error('^C never appeared on any set');
	});
});

/**
 * The row CYCLES — there is no popover any more, and that is the point.
 *
 * REPORTED FROM A PHONE, TWICE. First "the special-key popup covers too much of the screen"
 * (four stacked groups, 32 buttons, over a terminal a few hundred pixels tall). Shrinking it
 * to one row with ▲/▼ measured 20.7% of the pane — better, and still the wrong shape: a
 * popover is a thing ON TOP of what you are aiming at, so you had to close it to read what
 * you had just typed. The second report proposed the fix: turn the row's own keys instead.
 *
 * That costs zero screen, keeps every control where the thumb already learned it, and does
 * not cost a tap — `⌘` then the key, exactly as the popover did.
 */
describe('[TC-PDUI-197] the row turns to the next set of keys, and covers nothing', () => {
	it('draws no popover, ever — the row is the panel', async () => {
		const { container } = render(TerminalKeyBar, { props: {} });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			// Nothing is positioned over the terminal: every control this component owns lives
			// inside the row itself.
			expect(container.querySelector('[data-pdmux-popover]'), 'a popover came back').toBeNull();
			expect(container.querySelectorAll('[data-pdmux-keys]')).toHaveLength(1);
			for (const control of container.querySelectorAll('button')) {
				expect(control.closest('[data-pdmux-keys]'), 'a control escaped the row').not.toBeNull();
			}
			turn(container);
		}
	});

	it('shows one set at a time, and reaches every one of them by turning', async () => {
		const { container } = render(TerminalKeyBar, { props: {} });
		const seen: string[] = [];
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			seen.push(showing(container));
			// Exactly this set's keys are on the row — no leftovers from the page before.
			expect(faces(container)).toEqual([...(HELPER_KEY_SETS[visit]?.keys ?? [])]);
			turn(container);
		}
		expect(seen).toEqual(HELPER_KEY_SETS.map((set) => set.id));
		await tick();
		// ⚠ AND IT WRAPS. `⌘` that stops on the last set is a control that does nothing, which
		// is the same rule the scroll buttons are held to — and here it would also strand the
		// user one page away from `esc`.
		expect(showing(container), 'the page turn stopped instead of wrapping').toBe(HELPER_KEY_SETS[0]?.id);
	});

	it('opens on the arrows, so esc and the cursor keys cost no turn at all', () => {
		const { container } = render(TerminalKeyBar, { props: {} });
		expect(showing(container)).toBe(HELPER_KEY_SETS[0]?.id);
		expect(faces(container)).toContain('esc');
		for (const arrow of ['up', 'down', 'left', 'right']) expect(faces(container)).toContain(arrow);
	});

	it('never draws more than the row can hold', async () => {
		/**
		 * ⚠ THE MEASURED CEILING, ASSERTED ON THE RENDERED ROW rather than on the table. The
		 * row is `1 + set + 2` cells and 320px gives eight cells 32px each; a ninth narrows
		 * everything, the arrows included. jsdom cannot measure it, so the count is the proxy.
		 */
		const { container } = render(TerminalKeyBar, { props: {} });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			expect(container.querySelectorAll('[data-pdmux-keys] button').length, `set ${showing(container)}`).toBeLessThanOrEqual(8);
			turn(container);
		}
	});

	it('says which set is showing, for a reader that cannot see the glyphs', async () => {
		// A sighted user reads the set off the key faces. Without this a blind user turns the
		// page and hears nothing change at all.
		const { container } = render(TerminalKeyBar, { props: {} });
		const names: string[] = [];
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			const live = container.querySelector('[data-testid="terminal-keyset-name"]') as HTMLElement;
			expect(live.getAttribute('aria-live'), 'the set name is not announced on change').toBe('polite');
			names.push(live.textContent ?? '');
			turn(container);
		}
		for (const name of names) expect(name.length).toBeGreaterThan(1);
		expect(new Set(names).size, 'two sets announce the same name').toBe(HELPER_KEY_SETS.length);
	});

	it('gives every key a spoken name on every set', async () => {
		// `^C` reads as "caret C" and means nothing aloud; `←` reads as nothing at all.
		const { container } = render(TerminalKeyBar, { props: {} });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			for (const key of container.querySelectorAll('[data-pdmux-key]')) {
				expect((key.getAttribute('aria-label') ?? '').length, `${key.getAttribute('data-pdmux-key')}`).toBeGreaterThan(1);
			}
			turn(container);
		}
	});

	it('sends the key the set is showing, not the one the position used to hold', async () => {
		const onKey = vi.fn();
		const { container } = render(TerminalKeyBar, { props: { onKey } });
		turn(container);
		await tick();
		const first = container.querySelector('[data-pdmux-key]') as HTMLElement;
		expect(firePointerDown(first)).toBe(true);
		expect(onKey).toHaveBeenCalledWith(HELPER_KEY_SETS[1]?.keys[0]);
	});

	it('never offers the ctrl latch, on any set', async () => {
		// A latch a finger cannot see the state of is a trap; the ctrl set sends whole chords.
		const { container } = render(TerminalKeyBar, { props: {} });
		for (let visit = 0; visit < HELPER_KEY_SETS.length; visit += 1) {
			await tick();
			expect(container.querySelector('[data-pdmux-key="ctrl"]')).toBeNull();
			turn(container);
		}
	});
});
