/**
 * Reaching the scrollback behind a pane: the scrollbar that says it is there, and the
 * gesture that gets to it.
 *
 * WHY THESE ARE OFFLINE. Both defects were reported from a phone and both are pinned live in
 * `tests/ui/pdmux-terminal-scroll.mobile.spec.ts`, but a live spec needs an attached agent
 * and skips without one. The two things that can be decided without a browser are decided
 * here: that the two scrollers in this product agree on one thumb, and that the touch handler
 * translates a drag into exactly the keys xterm's own wheel handler would send.
 *
 * `@xterm/xterm` is mocked rather than run, following `[TC-PDUI-048]` in `terminal.test.ts`:
 * the real engine measures glyphs on a canvas jsdom does not have. The mock is shaped to the
 * three facts the gesture code reads — which buffer is active, whether the program asked for
 * the mouse, and how tall a row is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css');
const css = readFileSync(cssPath, 'utf8');

/** The declaration block for one selector, so a rule can be asserted without its neighbours. */
function block(selector: string): string {
	const at = css.indexOf(`${selector} {`);
	expect(at, `${selector} is not in styles.css`).toBeGreaterThan(-1);
	return css.slice(at, css.indexOf('}', at));
}

describe('[TC-PDTERM-129] a pane says when there is scrollback behind it', () => {
	it('dresses the terminal viewport in the same thumb as the commit list', () => {
		/**
		 * The commit list was already styled this way, so this is a shared vocabulary rather
		 * than a second opinion: one grey, one radius, one inset. Asserted against the OTHER
		 * scroller's declarations so a future change to either has to change both.
		 */
		const list = block('.pdmux-graph-list::-webkit-scrollbar-thumb');
		const term = block('.pdmux .xterm-viewport::-webkit-scrollbar-thumb');
		for (const declaration of ['background: #b6bdc9', 'border-radius: 6px', 'border: 2px solid transparent', 'background-clip: content-box']) {
			expect(list, `the commit list stopped declaring ${declaration}`).toContain(declaration);
			expect(term, `the terminal viewport must match the commit list on ${declaration}`).toContain(declaration);
		}
	});

	it('keeps the standard properties, which are the ones an overlay scrollbar obeys', () => {
		/**
		 * ⚠ THE PSEUDO-ELEMENTS ARE NOT ENOUGH, measured: on a Pixel 7 and on desktop
		 * Chromium alike, `offsetWidth - clientWidth` is 0 for an `overflow-y: scroll` div
		 * with `::-webkit-scrollbar` declared — the scrollbar stays an overlay. What Blink
		 * does honour there is `scrollbar-color`, so it is what actually tints the thumb the
		 * user sees. Losing it would silently return the phone to a default grey.
		 */
		const viewport = block('.pdmux .xterm-viewport');
		expect(viewport).toContain('scrollbar-color: #b6bdc9 transparent');
		expect(viewport).toContain('scrollbar-width: thin');
	});

	it('paints no track, so an idle pane shows nothing at all', () => {
		// A thumb appears only while the box is scrollable and being scrolled; a painted track
		// would be a permanent stripe on the terminal surface instead of a signal.
		expect(block('.pdmux .xterm-viewport::-webkit-scrollbar-track')).toContain('background: transparent');
	});

	it('leaves the page-level guard against pull-to-refresh in place', () => {
		// The gesture work below adds touch listeners; `overscroll-behavior` is what stops
		// Android reloading the page mid-session, and it is the thing a touch change breaks.
		expect(css).toMatch(/overscroll-behavior:\s*none/);
	});
});

// --- the gesture -------------------------------------------------------------

interface FakeTerminal {
	rows: number;
	element: HTMLElement;
	buffer: { active: { type: 'normal' | 'alternate'; baseY: number } };
	modes: { mouseTrackingMode: string; applicationCursorKeysMode: boolean };
	sent: string[];
	/** What xterm's own viewport was asked to do, in lines. */
	scrolled: number[];
	/**
	 * The handler the surface installed, called the way xterm calls it. Returning `false`
	 * is what stops xterm — on BOTH of its wheel paths, which is the whole reason this
	 * seam is the one being used.
	 */
	wheelHandler: ((event: WheelEvent) => boolean) | null;
}

/**
 * Build a surface over a mocked xterm and hand back the host plus the terminal's state, so a
 * case can put the terminal in a buffer and then dispatch a gesture at it.
 */
async function surfaceWithFakeTerminal(rowHeight = 20, rows = 24) {
	const element = document.createElement('div');
	// xterm's own shape: the wheel listeners sit on `.xterm`, and a mouse report is measured
	// against the `.xterm-screen` inside it. The scroll buttons aim at the inner one.
	const screen = document.createElement('div');
	screen.className = 'xterm-screen';
	element.append(screen);
	// jsdom lays nothing out, and the handler divides this height by `rows` to decide how many
	// lines a drag is worth. 24 rows x 20px is the geometry every case below reasons in.
	Object.defineProperty(element, 'clientHeight', { value: rowHeight * rows, configurable: true });

	const state = {
		rows,
		element,
		buffer: { active: { type: 'alternate' as 'normal' | 'alternate', baseY: 0 } },
		modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false },
		sent: [] as string[],
		scrolled: [] as number[],
		wheelHandler: null as ((event: WheelEvent) => boolean) | null,
	};

	vi.doMock('@xterm/xterm', () => ({
		Terminal: class {
			public rows = state.rows;
			public element = element;
			public buffer = state.buffer;
			public modes = state.modes;
			public loadAddon(): void {}
			public open(host: HTMLElement): void {
				host.append(element);
			}
			public attachCustomKeyEventHandler(): void {}
			public attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
				state.wheelHandler = handler;
			}
			public scrollLines(lines: number): void {
				state.scrolled.push(lines);
			}
			// Copy-on-select subscribes here; without it the surface cannot be constructed.
			public onSelectionChange(): { dispose(): void } {
				return { dispose(): void {} };
			}
			public onData(): { dispose(): void } {
				return { dispose(): void {} };
			}
			public getSelection(): string {
				return '';
			}
			public write(): void {}
			public input(data: string): void {
				state.sent.push(data);
			}
			public focus(): void {}
			public dispose(): void {}
		},
	}));
	vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { public fit(): void {} } }));
	vi.resetModules();
	const { createXtermSurface } = await import('../src/adapters/terminal-surface.js');
	const host = document.createElement('div');
	document.body.append(host);
	const surface = await createXtermSurface(host);
	return { host, surface, term: state as unknown as FakeTerminal };
}

/**
 * A touch event jsdom can carry.
 *
 * jsdom implements neither `TouchEvent` nor `Touch` (the same reason the pointer gestures in
 * `terminal.test.ts` are dispatched as `MouseEvent`s), so the two properties the handler reads
 * are defined onto a plain event. `cancelable` matters: the handler only calls
 * `preventDefault` on a move it consumed, and a case below asserts exactly that.
 */
function touch(type: string, points: { x: number; y: number }[]): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'touches', {
		value: points.map((point) => ({ clientX: point.x, clientY: point.y })),
	});
	return event;
}

function drag(host: HTMLElement, from: { x: number; y: number }, moves: { x: number; y: number }[]): Event[] {
	host.dispatchEvent(touch('touchstart', [from]));
	const dispatched: Event[] = [];
	for (const move of moves) {
		const event = touch('touchmove', [move]);
		host.dispatchEvent(event);
		dispatched.push(event);
	}
	host.dispatchEvent(touch('touchend', []));
	return dispatched;
}

describe('[TC-PDTERM-130] a finger reaches the same history the wheel reaches', () => {
	afterEach(() => {
		vi.doUnmock('@xterm/xterm');
		vi.doUnmock('@xterm/addon-fit');
		document.body.innerHTML = '';
	});

	it('sends the wheel’s own keys when the alternate buffer holds no scrollback', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// 60px down over three moves, 20px to a row: three lines of earlier output.
		const events = drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 120 },
			{ x: 50, y: 140 },
			{ x: 50, y: 160 },
		]);
		// Cursor UP is what xterm's own wheel handler sends for a wheel that pulls earlier
		// output down, and a finger travelling down is the same intent.
		expect(term.sent.join('')).toBe('\u001b[A\u001b[A\u001b[A');
		// …and it only claimed the moves it acted on, so nothing else on the page loses a
		// gesture it would otherwise have seen.
		expect(events.every((event) => event.defaultPrevented)).toBe(true);
		surface.dispose();
	});

	it('follows the terminal into application-cursor mode', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		term.modes.applicationCursorKeysMode = true;
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 130 }]);
		// `ESC O A`, not `ESC [ A` — a full-screen program that asked for application keys
		// does not recognise the other form. Measured on a live tmux pane: `ESC O A`.
		expect(term.sent.join('')).toBe('\u001bOA');
		surface.dispose();
	});

	it('sends cursor down when the finger travels up', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		drag(host, { x: 50, y: 200 }, [{ x: 50, y: 160 }]);
		expect(term.sent.join('')).toBe('\u001b[B\u001b[B');
		surface.dispose();
	});

	it('leaves the normal buffer to xterm, which scrolls its own viewport', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		term.buffer.active.type = 'normal';
		const events = drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 140 },
			{ x: 50, y: 180 },
		]);
		// Nothing sent and nothing cancelled: xterm's own touch handling owns this buffer, and
		// a second scroller on top of it would double every drag.
		expect(term.sent).toEqual([]);
		expect(events.some((event) => event.defaultPrevented)).toBe(false);
		surface.dispose();
	});

	it('stands down when the program asked for the mouse', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		term.modes.mouseTrackingMode = 'vt200';
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 160 }]);
		// Mirrors xterm's own `areMouseEventsActive` bail: the touch belongs to the program.
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('does not turn a tap into a keypress', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// A finger never lands perfectly still. Under the axis-lock threshold nothing is
		// claimed, which is what keeps tap-to-focus — and therefore the software keyboard.
		const events = drag(host, { x: 50, y: 100 }, [
			{ x: 51, y: 103 },
			{ x: 52, y: 105 },
		]);
		expect(term.sent).toEqual([]);
		expect(events.some((event) => event.defaultPrevented)).toBe(false);
		surface.dispose();
	});

	it('releases a horizontal drag for good', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// The axis is locked on the first real movement: the shell's view swipe and the
		// browser's back gesture are horizontal, and a scroller that grabbed them would be a
		// worse bug than the one being fixed. The later vertical travel must not revive it.
		const events = drag(host, { x: 100, y: 100 }, [
			{ x: 160, y: 104 },
			{ x: 200, y: 200 },
		]);
		expect(term.sent).toEqual([]);
		expect(events.some((event) => event.defaultPrevented)).toBe(false);
		surface.dispose();
	});

	it('ignores a second finger, so a pinch is not a scroll', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		host.dispatchEvent(touch('touchstart', [{ x: 50, y: 100 }]));
		host.dispatchEvent(
			touch('touchmove', [
				{ x: 50, y: 160 },
				{ x: 80, y: 200 },
			]),
		);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('caps one move, so a fling cannot become a hundred keypresses', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// 600px in one event is 30 rows; the handler is bounded at 8 per move.
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 700 }]);
		expect(term.sent).toEqual(['\u001b[A'.repeat(8)]);
		surface.dispose();
	});

	it('adds slow drags up instead of rounding them away', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// Four 12px moves over a 20px row: the remainder is carried, so the drag is worth two
		// lines rather than nothing. The first move also has to clear the 8px axis lock.
		drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 112 },
			{ x: 50, y: 124 },
			{ x: 50, y: 136 },
			{ x: 50, y: 148 },
		]);
		expect(term.sent.join('')).toBe('\u001b[A\u001b[A');
		surface.dispose();
	});

	it('stops listening when the surface is disposed', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		surface.dispose();
		// The host outlives the surface — retargeting a pane builds a new surface on the same
		// element — so a leaked listener would scroll a terminal that is gone.
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 160 }]);
		expect(term.sent).toEqual([]);
	});
});

// --- the two scroll buttons --------------------------------------------------

/** Every wheel event the surface handed the terminal, in order. */
function recordWheel(term: FakeTerminal): WheelEvent[] {
	const seen: WheelEvent[] = [];
	// On the OUTER element, which is where xterm puts both of its wheel listeners: an event
	// that does not reach here is an event xterm would never have routed.
	term.element.addEventListener('wheel', (event) => seen.push(event as WheelEvent));
	return seen;
}

describe('[TC-PDUI-196] the scroll buttons are a wheel, and the gate is never latched', () => {
	afterEach(() => {
		vi.doUnmock('@xterm/xterm');
		vi.doUnmock('@xterm/addon-fit');
		document.body.innerHTML = '';
	});

	it('hands the terminal a page of wheel notches instead of scrolling anything itself', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		surface.scrollPages(-1);

		/**
		 * ⚠ NOTCHES, NOT ONE BIG DELTA. A mouse report carries no magnitude — xterm reads
		 * `deltaY` only to check it is non-zero before encoding ONE report — so a program that
		 * captures the mouse (a coding agent's TUI, a multiplexer with mouse mode on) would
		 * move a single notch however large a single event was. 24 rows is a 23-line page,
		 * which is 8 three-line notches.
		 */
		expect(wheeled.length).toBe(8);
		for (const event of wheeled) {
			expect(event.deltaY, 'a notch is three lines back, the way a mouse reports one').toBe(-3);
			// Lines, not pixels: a pixel delta is divided by a row height xterm measures on a
			// canvas, and the remainder is carried between events rather than used.
			expect(event.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
			// It has to reach the listeners on the outer element to be routed at all.
			expect(event.bubbles).toBe(true);
			// …and be cancellable, because routing it ends in `preventDefault`.
			expect(event.cancelable).toBe(true);
			// Aimed at the screen, which is what a mouse report is measured against.
			expect((event.target as HTMLElement).className).toBe('xterm-screen');
		}

		/**
		 * AND IT TRANSLATES NOTHING ITSELF. Which of three answers is right — a mouse report,
		 * cursor keys, or xterm's own viewport — depends on what the program is doing at this
		 * instant, and xterm re-decides that on every wheel event. A copy of that decision here
		 * would be a second opinion that drifts. This mock has no routing, so anything on the
		 * wire would be this file's own invention.
		 */
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('sends the wheel forward when the button is the down one', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		surface.scrollPages(1);
		expect(wheeled.length).toBe(8);
		expect(wheeled.every((event) => event.deltaY === 3)).toBe(true);
		surface.dispose();
	});

	it('scales the page to the pane, so a 3x3 cell is not paged by a full screen’s worth', async () => {
		// Ten rows is a nine-line page, i.e. three notches — against the eight a 24-row pane
		// gets above. A pane in a 3x3 grid is a few hundred pixels tall and a fixed count would
		// overshoot it every time.
		const { surface, term } = await surfaceWithFakeTerminal(20, 10);
		const wheeled = recordWheel(term);
		surface.scrollPages(-1);
		expect(wheeled.length).toBe(3);
		surface.dispose();
	});

	it('says a wheel reaches something whenever it does — and re-answers every time', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();

		// 1. A multiplexer or a full-screen program: xterm turns the wheel into cursor keys.
		term.buffer.active.type = 'alternate';
		expect(surface.canScroll()).toBe(true);

		/**
		 * ⚠ THE REGRESSION THIS FILE EXISTS FOR. `canScroll` used to be `type !== 'alternate'`
		 * and was read ONLY from inside the press it gated, so the first tap on a multiplexer
		 * pane latched both buttons off for the life of the pane — reported from a phone as
		 * "they do nothing, and they disappear the moment I press them".
		 */
		surface.scrollPages(-1);
		expect(surface.canScroll(), 'the press turned the buttons off — the latch is back').toBe(true);

		// 2. A program that captures the mouse scrolls its own transcript from the wheel.
		term.buffer.active.type = 'normal';
		term.modes.mouseTrackingMode = 'vt200';
		expect(surface.canScroll()).toBe(true);

		// 3. A plain shell with output behind it: xterm's own viewport has somewhere to go.
		term.modes.mouseTrackingMode = 'none';
		term.buffer.active.baseY = 12;
		expect(surface.canScroll()).toBe(true);

		// …and nothing at all behind it, which is the one case a wheel would also not move.
		term.buffer.active.baseY = 0;
		expect(surface.canScroll()).toBe(false);

		// Leaving `vim` has to bring them BACK, which the latched version could never do.
		term.buffer.active.type = 'alternate';
		expect(surface.canScroll()).toBe(true);
		surface.dispose();
	});
});

describe('[TC-PDUI-216] Shift takes the wheel back from the program, and only Shift', () => {
	afterEach(() => {
		vi.doUnmock('@xterm/xterm');
		vi.doUnmock('@xterm/addon-fit');
		document.body.innerHTML = '';
	});

	/** A wheel event shaped the way a mouse sends one. */
	const wheel = (over: Partial<WheelEventInit> = {}): WheelEvent =>
		new WheelEvent('wheel', { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE, ...over });
	/** The same gesture with the escape hatch held down. */
	const shifted = (over: Partial<WheelEventInit> = {}): WheelEvent => wheel({ shiftKey: true, ...over });

	it('leaves the plain wheel entirely alone, whatever the program is doing', async () => {
		/**
		 * ⚠ THIS IS THE HALF THAT PROTECTS THE PANE THAT ALREADY WORKS. The report was
		 * "one pane scrolls, the other does not" — and the one that scrolls does so
		 * BECAUSE the wheel reaches the program as a mouse report. Claiming the plain
		 * wheel here would fix the broken pane by breaking the working one, and would take
		 * the mouse away from every full-screen program that uses it for anything else.
		 */
		const { surface, term } = await surfaceWithFakeTerminal();
		const asked: number[] = [];
		surface.onScrollbackRequest((direction) => asked.push(direction));

		for (const mode of ['none', 'vt200', 'any']) {
			term.modes.mouseTrackingMode = mode;
			for (const type of ['normal', 'alternate'] as const) {
				term.buffer.active.type = type;
				expect(term.wheelHandler?.(wheel()), `plain wheel was claimed in ${mode}/${type}`).toBe(true);
			}
		}
		expect(term.scrolled).toEqual([]);
		expect(asked).toEqual([]);
		surface.dispose();
	});

	it('scrolls xterm itself when xterm is the one holding the history', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();
		term.buffer.active.type = 'normal';
		// A program has captured the mouse, which is exactly when handing the event back
		// would achieve nothing: xterm skips its own scrollback branch outright then.
		term.modes.mouseTrackingMode = 'vt200';

		expect(term.wheelHandler?.(shifted({ deltaY: -3 }))).toBe(false);
		expect(term.scrolled).toEqual([-3]);
		// Pixels are divided by the row height the surface measures (24 rows x 20px).
		expect(term.wheelHandler?.(shifted({ deltaY: 40, deltaMode: WheelEvent.DOM_DELTA_PIXEL }))).toBe(false);
		expect(term.scrolled).toEqual([-3, 2]);
		surface.dispose();
	});

	it('asks upward when there is no local history to scroll, and never types', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();
		// A multiplexer pane: xterm keeps NO scrollback in the alternate buffer, so the
		// history is tmux's and only tmux can show it.
		term.buffer.active.type = 'alternate';
		const asked: number[] = [];
		const stop = surface.onScrollbackRequest((direction) => asked.push(direction));

		expect(term.wheelHandler?.(shifted({ deltaY: -3 }))).toBe(false);
		expect(term.wheelHandler?.(shifted({ deltaY: 3 }))).toBe(false);
		expect(asked).toEqual([-1, 1]);
		// ⚠ NOT ONE BYTE. Every rejected design for this ended in typing something into
		// somebody's running program — a prefix that may be rebound, or a PageUp the
		// measured programs do not answer to. A scroll gesture must never edit a session.
		expect(term.sent).toEqual([]);
		expect(term.scrolled).toEqual([]);

		stop();
		term.wheelHandler?.(shifted());
		expect(asked, 'the unsubscribe did not take').toEqual([-1, 1]);
		surface.dispose();
	});

	it('ignores a wheel event that carries no movement', async () => {
		// A horizontal scroll (or a trackpad settling) fires with `deltaY: 0`; entering a
		// scroll mode on it would be a mode the user never asked for.
		const { surface, term } = await surfaceWithFakeTerminal();
		const asked: number[] = [];
		surface.onScrollbackRequest((direction) => asked.push(direction));
		expect(term.wheelHandler?.(shifted({ deltaY: 0 }))).toBe(true);
		expect(asked).toEqual([]);
		surface.dispose();
	});
});
