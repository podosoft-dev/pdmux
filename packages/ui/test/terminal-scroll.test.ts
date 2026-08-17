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
	/** What the surface asked xterm for. `scrollback` is load-bearing — see the gesture cases. */
	options: { scrollback?: number };
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
		options: {} as { scrollback?: number },
		buffer: { active: { type: 'alternate' as 'normal' | 'alternate', baseY: 0 } },
		modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false },
		sent: [] as string[],
		scrolled: [] as number[],
		wheelHandler: null as ((event: WheelEvent) => boolean) | null,
	};

	vi.doMock('@xterm/xterm', () => ({
		Terminal: class {
			public constructor(options: { scrollback?: number }) {
				state.options = options;
			}
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

/**
 * Dispatch where a finger actually lands, which is the DEEPEST element, and let it bubble.
 *
 * ⚠ NOT ON THE HOST. A real touch targets `.xterm-screen`, so the event passes xterm's own
 * listeners on `.xterm` before it reaches the surface's on the host — and the whole
 * double-scroll guard is "did one of those cancel it". Dispatching straight at the host skips
 * the element in the middle, which is the one case that has to be reproducible here.
 */
function fire(host: HTMLElement, event: Event): void {
	(host.querySelector('.xterm-screen') ?? host).dispatchEvent(event);
}

function drag(host: HTMLElement, from: { x: number; y: number }, moves: { x: number; y: number }[]): Event[] {
	fire(host, touch('touchstart', [from]));
	const dispatched: Event[] = [];
	for (const move of moves) {
		const event = touch('touchmove', [move]);
		fire(host, event);
		dispatched.push(event);
	}
	fire(host, touch('touchend', []));
	return dispatched;
}

describe('[TC-PDTERM-130] a finger reaches the same history the wheel reaches', () => {
	afterEach(() => {
		vi.doUnmock('@xterm/xterm');
		vi.doUnmock('@xterm/addon-fit');
		document.body.innerHTML = '';
	});

	/**
	 * ⚠ WHAT THIS FILE CAN AND CANNOT DECIDE, because it matters to every case below.
	 *
	 * The drag no longer translates anything: it dispatches a wheel event and xterm routes it
	 * (a mouse report for a program that asked for one, else cursor keys for a buffer with no
	 * scrollback, else its own viewport). This mock has no routing, so the ROUTING is not
	 * testable here — `tests/ui/pdmux-terminal-scroll.mobile.spec.ts` drives a real engine for
	 * that. What is decidable here is that the gesture produces exactly the wheel a mouse would
	 * have, and that it invents nothing of its own.
	 *
	 * So the negative assertion (`term.sent` empty) is never left on its own: it passes just as
	 * happily against no feature at all. Every case pairs it with the wheel it expects.
	 */
	it('turns the drag into the notches a mouse would have spun', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		// 20px to a row and three rows to a notch: 60px of travel is one notch, and 120px is
		// two. The first move also has to clear the 8px axis lock, which it does.
		const events = drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 160 },
			{ x: 50, y: 220 },
		]);
		expect(wheeled.length).toBe(2);
		for (const event of wheeled) {
			// A finger travelling DOWN pulls earlier output down into view, which is a wheel
			// turned back — the same sign the ⇞ button sends.
			expect(event.deltaY).toBe(-3);
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
		// AND NOTHING OF ITS OWN. Anything on the wire from a mock with no routing would be
		// this handler's invention — which is exactly what the hand-rolled version was.
		expect(term.sent).toEqual([]);
		// It claimed only the moves it acted on, so nothing else on the page loses a gesture.
		expect(events.every((event) => event.defaultPrevented)).toBe(true);
		surface.dispose();
	});

	it('turns the wheel forward when the finger travels up', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		drag(host, { x: 50, y: 200 }, [{ x: 50, y: 140 }]);
		expect(wheeled.map((event) => event.deltaY)).toEqual([3]);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	/**
	 * THE REGRESSION THIS ROUND EXISTS FOR — reported from an iPhone against a deployed
	 * dashboard, on a pane running a coding agent.
	 *
	 * The handler used to return early whenever the program had asked for mouse reporting,
	 * mirroring xterm's own `areMouseEventsActive` bail. But xterm bails there because it is
	 * about to move its own viewport, which would be the wrong answer; the wheel path has a
	 * right answer for that case and only that path knows it. Standing down meant a phone had
	 * NO gesture at all on exactly the panes this product exists to watch, while a desktop
	 * wheel worked — so the operator had to walk to a computer to read what the agent had done.
	 */
	it('reaches a program that captured the mouse, which is what a phone could not do', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		term.modes.mouseTrackingMode = 'vt200';
		const wheeled = recordWheel(term);
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 160 }]);
		// One notch, which xterm encodes as one mouse report — the magnitude is not carried, so
		// the COUNT is the whole message.
		expect(wheeled.length).toBe(1);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('turns the wheel on the normal buffer too, when nobody else consumed the move', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		term.buffer.active.type = 'normal';
		const wheeled = recordWheel(term);
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 160 }]);
		/**
		 * The old guard was `type !== 'alternate' → return`, which read as "the normal buffer is
		 * xterm's". It is — but only while xterm is actually scrolling it, which it announces by
		 * cancelling the move (the case below). At the top or bottom of its scrollback it stops
		 * cancelling, and there a wheel is what a program with the mouse would still want.
		 */
		expect(wheeled.length).toBe(1);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('stands aside for a move xterm has already consumed, so a drag is never scrolled twice', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		/**
		 * ⚠ THIS IS THE REAL GUARD, AND IT IS WHY THIS LISTENER IS ON THE OUTER ELEMENT.
		 * xterm's own touch listeners sit on `.xterm` (`term.element` here — the same place the
		 * real ones go), and `Viewport._bubbleScroll` calls `preventDefault` only on a move it
		 * actually scrolled. Standing in for that listener is a faithful stand-in rather than a
		 * proxy, because the position and the signal are both the real ones.
		 */
		term.element.addEventListener('touchmove', (event) => event.preventDefault());
		const wheeled = recordWheel(term);
		drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 160 },
			{ x: 50, y: 220 },
		]);
		expect(wheeled).toEqual([]);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('never asks the multiplexer for its history — that is Shift’s job, not a drag’s', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const asked: number[] = [];
		const off = surface.onScrollbackRequest((direction) => asked.push(direction));
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 220 }]);
		/**
		 * The synthesized wheel carries no Shift, and the Shift branch is the only thing that
		 * fires this. It matters more than it looks: the listener ends in an HTTP request that
		 * runs `tmux copy-mode` on somebody's machine, so a drag that woke it would put a
		 * command on a remote host on every touchmove.
		 */
		expect(asked).toEqual([]);
		expect(term.sent).toEqual([]);
		off();
		surface.dispose();
	});

	it('keeps xterm’s own scrollback bigger than the pane, or a drag at a prompt would recall history', async () => {
		const { surface, term } = await surfaceWithFakeTerminal();
		/**
		 * ⚠ THE COUPLING THE `alternate` GUARD USED TO HIDE. xterm picks the cursor-key branch
		 * when `hasScrollback` is false, and that is `maxLength > rows` with
		 * `maxLength = rows + scrollback` (`Buffer.ts:91`) — true even on an empty buffer, so a
		 * wheel on the normal buffer can only ever reach the viewport. Set `scrollback` to
		 * `rows` or less and the same drag starts sending `ESC[A` at a shell prompt, which is
		 * the shell's own history recall. The two numbers are one decision.
		 */
		expect(term.options.scrollback).toBeGreaterThan(term.rows);
		surface.dispose();
	});

	it('declares the axis it claims, so the engine cannot commit the gesture first', async () => {
		/**
		 * An engine that has decided a touch is a native pan hands over uncancellable moves from
		 * then on, and `preventDefault` becomes a silent no-op. `touchstart` is registered
		 * `passive: true` (it only records a position), which is an invitation to decide without
		 * us — so the axis is declared in CSS as well as enforced in JS.
		 *
		 * ⚠ AND NOT `none`: pinch-zoom has to survive (`app.html` ships no `user-scalable=no`),
		 * and the horizontal axis is released by the handler anyway.
		 */
		const surfaceRule = block('.pdmux-pane-surface');
		expect(surfaceRule).toContain('touch-action: pan-x pinch-zoom');
	});

	it('does not turn a tap into a scroll', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		// A finger never lands perfectly still. Under the axis-lock threshold nothing is
		// claimed, which is what keeps tap-to-focus — and therefore the software keyboard.
		const events = drag(host, { x: 50, y: 100 }, [
			{ x: 51, y: 103 },
			{ x: 52, y: 105 },
		]);
		expect(wheeled).toEqual([]);
		expect(term.sent).toEqual([]);
		expect(events.some((event) => event.defaultPrevented)).toBe(false);
		surface.dispose();
	});

	it('releases a horizontal drag for good', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		// The axis is locked on the first real movement: the browser's edge/back gesture is
		// horizontal, and a scroller that grabbed it would be a worse bug than the one being
		// fixed. The later vertical travel must not revive it.
		const events = drag(host, { x: 100, y: 100 }, [
			{ x: 160, y: 104 },
			{ x: 200, y: 200 },
		]);
		expect(recordWheel(term)).toEqual([]);
		expect(term.sent).toEqual([]);
		expect(events.some((event) => event.defaultPrevented)).toBe(false);
		surface.dispose();
	});

	it('ignores a second finger, so a pinch is not a scroll', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		fire(host, touch('touchstart', [{ x: 50, y: 100 }]));
		fire(
			host,
			touch('touchmove', [
				{ x: 50, y: 160 },
				{ x: 80, y: 200 },
			]),
		);
		expect(wheeled).toEqual([]);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('caps one move, so a fling cannot become a page-long jump', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		// 600px in one event is ten notches; the handler is bounded at three per move — nine
		// lines, which is where the cap sat when this sent keys, so the change of mechanism is
		// not also a change of speed. Every notch is a frame on the socket once xterm encodes
		// it, and a coalesced move on a tall pane could otherwise be a dozen.
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 700 }]);
		expect(wheeled.length).toBe(3);
		surface.dispose();
	});

	it('adds slow drags up instead of rounding them away', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		// Three 25px moves against a 60px notch: each one alone rounds to nothing, and together
		// they are worth one notch with 15px carried on. The first also clears the axis lock.
		drag(host, { x: 50, y: 100 }, [
			{ x: 50, y: 125 },
			{ x: 50, y: 150 },
			{ x: 50, y: 175 },
		]);
		expect(wheeled.length).toBe(1);
		expect(term.sent).toEqual([]);
		surface.dispose();
	});

	it('stops listening when the surface is disposed', async () => {
		const { host, surface, term } = await surfaceWithFakeTerminal();
		const wheeled = recordWheel(term);
		surface.dispose();
		// The host outlives the surface — retargeting a pane builds a new surface on the same
		// element — so a leaked listener would scroll a terminal that is gone.
		drag(host, { x: 50, y: 100 }, [{ x: 50, y: 220 }]);
		expect(wheeled).toEqual([]);
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
