/**
 * Terminal grid and pane wiring.
 *
 * jsdom has no pointer-event constructor, so the gestures are dispatched as
 * `MouseEvent`s with the pointer type name — that carries the coordinates the click
 * guard classifies on, which is what these cases are about.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { type GridHost, type TerminalLayout, buildDefaultSlots, defaultLayout, normalizeLayout } from '@pdmux/core';
import { EchoTerminalAdapter } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import EmptyCell from '../src/components/EmptyCell.svelte';
import TerminalGrid from '../src/components/TerminalGrid.svelte';
import TerminalPane from '../src/components/TerminalPane.svelte';
import TerminalTargetPicker from '../src/components/TerminalTargetPicker.svelte';

afterEach(cleanup);

const HOSTS: GridHost[] = [
	{
		id: 'h1',
		name: 'alpha',
		online: true,
		sessions: [{ name: 'main', attached: 1, windows: 2 }],
	},
	{ id: 'h2', name: 'beta', online: false, sessions: [] },
];

/** A surface that records everything, so the wiring is testable without a canvas. */
function fakeSurface(): {
	factory: () => TerminalSurface;
	written: string[];
	scrolled: number[];
	type: (data: string) => void;
	disposed: () => number;
	/** What `canScroll` answers next — a real one changes its mind as the program runs. */
	setScrollable: (next: boolean) => void;
	/**
	 * Whether `readHistory` claims to be a real history. A real surface answers `false`
	 * on the alternate buffer, which is where every multiplexer pane lives — and that is
	 * exactly the case the remote fetch exists for.
	 */
	setScrollback: (next: boolean) => void;
} {
	const written: string[] = [];
	const listeners = new Set<(data: string) => void>();
	let disposals = 0;
	let scrollable = true;
	let scrollback = true;
	const scrolled: number[] = [];
	const surface: TerminalSurface = {
		write: (data) => written.push(data),
		fit: () => ({ cols: 80, rows: 24 }),
		focus: () => undefined,
		scrollPages: (delta) => scrolled.push(delta),
		canScroll: () => scrollable,
		readHistory: () => ({ lines: written.join('').split('\n'), scrollback }),
		onScrollbackRequest: () => () => undefined,
		onData: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => {
			disposals++;
		},
	};
	return {
		factory: () => surface,
		written,
		scrolled,
		type: (data) => {
			for (const listener of listeners) listener(data);
		},
		disposed: () => disposals,
		setScrollable: (next) => {
			scrollable = next;
		},
		setScrollback: (next) => {
			scrollback = next;
		},
	};
}

const pointer = (type: string, x: number, y: number): MouseEvent =>
	new MouseEvent(type, {
		clientX: x,
		clientY: y,
		bubbles: true,
		cancelable: true,
	});

const layoutWith = (over: Partial<TerminalLayout> = {}): TerminalLayout => ({
	...defaultLayout(),
	slots: buildDefaultSlots(HOSTS, { pad: 2 }),
	...over,
});

describe('[TC-PDUI-010] the grid renders exactly one window of cells', () => {
	it('fills the window with panes and empty cells, and sets the column count', async () => {
		const surface = fakeSurface();
		const { container } = render(TerminalGrid, {
			props: {
				layout: layoutWith({ mode: 'split4' }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				sweepMs: 0,
			},
		});
		await vi.waitFor(() => expect(container.querySelectorAll('[data-pdmux-cell]').length).toBe(4));
		expect((container.querySelector('.pdmux-grid') as HTMLElement).style.getPropertyValue('--pdmux-cols')).toBe('2');
		// alpha contributes main + two spare cells, so the fourth cell is padding.
		expect(container.querySelectorAll('.pdmux-pane:not(.pdmux-pane-empty)')).toHaveLength(3);
		expect(container.querySelectorAll('.pdmux-pane-empty')).toHaveLength(1);
	});

	it('keeps a paged-away pane mounted but hidden, so its terminal survives', async () => {
		const surface = fakeSurface();
		const props = {
			layout: layoutWith({ mode: 'split2', page: 0 }),
			hosts: HOSTS,
			adapter: new EchoTerminalAdapter(),
			createSurface: surface.factory,
			sweepMs: 0,
		};
		const { container, rerender } = render(TerminalGrid, { props });
		await vi.waitFor(() => expect(container.querySelectorAll('[data-pdmux-pane]').length).toBe(2));
		const first = container.querySelector('[data-pdmux-pane]')?.getAttribute('data-pdmux-pane');
		await rerender({
			...props,
			layout: layoutWith({ mode: 'split2', page: 1 }),
		});
		const pane = container.querySelector(`[data-pdmux-pane="${first}"]`) as HTMLElement;
		expect(pane).not.toBeNull();
		expect(pane.hasAttribute('hidden')).toBe(true); // still mounted, just not shown
	});
});

describe('[TC-PDUI-011] an empty cell is a first-class cell', () => {
	it('keeps the header, and only a hole can be closed', () => {
		const onAssign = vi.fn();
		const onRemove = vi.fn();
		const hole = render(EmptyCell, {
			props: { index: 2, kind: 'hole', onAssign, onRemove },
		});
		expect(hole.container.querySelector('.pdmux-pane-label')?.textContent).toContain('#3');
		const [assign, close] = [...hole.container.querySelectorAll('.pdmux-ico')] as HTMLButtonElement[];
		expect(close!.disabled).toBe(false);
		close!.click();
		expect(onRemove).toHaveBeenCalledWith(2);
		assign!.click();
		expect(onAssign).toHaveBeenCalledWith(2, expect.anything());

		// Padding has nothing to pull forward, so the button is disabled rather than
		// dead.
		const padding = render(EmptyCell, {
			props: { index: 5, kind: 'padding', onRemove },
		});
		const [, paddingClose] = [...padding.container.querySelectorAll('.pdmux-ico')] as HTMLButtonElement[];
		expect(paddingClose!.disabled).toBe(true);
		paddingClose!.click();
		expect(onRemove).toHaveBeenCalledTimes(1);
	});
});

describe('[TC-PDUI-012] a pane header offers its actions and classifies its gestures', () => {
	it('calls back for retarget, history, zoom, detach and close', async () => {
		const surface = fakeSurface();
		const calls = {
			assign: vi.fn(),
			zoom: vi.fn(),
			detach: vi.fn(),
			close: vi.fn(),
		};
		const slot = {
			id: 's1',
			hostId: 'h1',
			kind: 'attach' as const,
			session: 'main',
		};
		const { container } = render(TerminalPane, {
			props: {
				slot,
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onAssign: calls.assign,
				onZoom: calls.zoom,
				onDetach: calls.detach,
				onClose: calls.close,
			},
		});
		// Addressed by their own hooks rather than by position: an index-keyed list of
		// clicks silently retargets itself the next time a control is inserted, and this
		// test is the one that would have to notice.
		const buttons = [...container.querySelectorAll('.pdmux-pane-acts .pdmux-ico')] as HTMLButtonElement[];
		expect(buttons).toHaveLength(5);
		(container.querySelector('[data-pdmux-retarget]') as HTMLButtonElement).click();
		(container.querySelector('[data-pdmux-history]') as HTMLButtonElement).click();
		buttons[2]!.click(); // zoom
		buttons[3]!.click(); // detach
		(container.querySelector('[data-pdmux-close]') as HTMLButtonElement).click();
		expect(calls.assign).toHaveBeenCalledWith(0, expect.anything());
		expect(calls.zoom).toHaveBeenCalledWith('s1');
		expect(calls.detach).toHaveBeenCalledWith(slot);
		expect(calls.close).toHaveBeenCalledWith(0);
		expect(container.querySelector('.pdmux-pane-label')?.textContent).toContain('alpha·main');

		// History opens a sheet from the pane's own buffer.
		// Flushed first: a Svelte 5 state change lands on a microtask, and querying before
		// it does reads the old DOM.
		await tick();
		expect(container.querySelector('[data-testid="terminal-history"]')).not.toBeNull();
	});

	it('[TC-PDUI-217] offers scroll mode only when someone can serve it, and says it is on', async () => {
		const surface = fakeSurface();
		const slot = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const base = {
			slot,
			index: 0,
			hostName: 'alpha',
			adapter: new EchoTerminalAdapter(),
			createSurface: surface.factory,
		};

		// ⚠ NO CALLBACK, NO CONTROL. A button that announces "scroll mode" and reaches
		// nothing is the scroll buttons' original bug — it was reported as "they do
		// nothing and then vanish", and the lesson was to draw only what can act.
		const bare = render(TerminalPane, { props: base });
		expect(bare.container.querySelector('[data-pdmux-scrollback]')).toBeNull();
		cleanup();

		const onScrollback = vi.fn();
		const { container } = render(TerminalPane, { props: { ...base, onScrollback } });
		const button = container.querySelector('[data-pdmux-scrollback]') as HTMLButtonElement;
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(container.querySelector('[data-pdmux-scroll-hint]')).toBeNull();

		button.click();
		await tick();
		expect(onScrollback).toHaveBeenCalledWith(slot, 'enter');
		expect(button.getAttribute('aria-pressed')).toBe('true');
		// ⚠ THE PANE LOOKS IDENTICAL IN THIS MODE, and the keys stop reaching the program.
		// Without a line saying so, "my terminal stopped accepting input" is the next report.
		expect(container.querySelector('[data-pdmux-scroll-hint]')).not.toBeNull();

		button.click();
		await tick();
		expect(onScrollback).toHaveBeenLastCalledWith(slot, 'exit');
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(container.querySelector('[data-pdmux-scroll-hint]')).toBeNull();
	});

	it('[TC-PDUI-217] paints the local buffer first, then replaces it with the real history', async () => {
		const surface = fakeSurface();
		// A multiplexer pane: xterm holds no scrollback, so the sheet has only the screen.
		surface.setScrollback(false);
		const slot = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const onReadHistory = vi.fn(async () => ({ lines: ['much older', 'echo terminal'], scrollback: true }));
		const { container } = render(TerminalPane, {
			props: {
				slot,
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onReadHistory,
			},
		});

		// The echo adapter's banner arrives on a microtask, so wait for the pane to have a
		// buffer at all — otherwise this measures an empty sheet either way.
		await vi.waitFor(() => expect(surface.written.length).toBeGreaterThan(0));
		(container.querySelector('[data-pdmux-history]') as HTMLButtonElement).click();
		await tick();
		// ⚠ SOMETHING IS ON SCREEN BEFORE THE ROUND TRIP. The fetch crosses to another
		// machine; a sheet that opens empty and fills in later reads as a broken one.
		const body = () => container.querySelector('[data-pdmux-history-body]')?.textContent ?? '';
		expect(body()).toContain('echo terminal');

		await vi.waitFor(() => expect(body()).toContain('much older'));
		expect(onReadHistory).toHaveBeenCalledWith(slot);
	});

	it('[TC-PDUI-217] keeps the visible screen, and its notice, when the history cannot be had', async () => {
		const surface = fakeSurface();
		surface.setScrollback(false);
		const slot = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const { container } = render(TerminalPane, {
			props: {
				slot,
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				// A host with no tmux, an agent too old for `exec`, a dead network: the sheet
				// must fall back to what it can prove rather than opening blank.
				onReadHistory: vi.fn(async () => {
					throw new Error('nope');
				}),
			},
		});

		await vi.waitFor(() => expect(surface.written.length).toBeGreaterThan(0));
		(container.querySelector('[data-pdmux-history]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(container.querySelector('[data-pdmux-history-body]')?.textContent).toContain('echo terminal');
		expect(container.querySelector('[data-testid="terminal-history"]')).not.toBeNull();
	});

	it('[TC-PDUI-217] says the ask failed instead of passing the screen off as the history', async () => {
		/**
		 * ⚠ THE FALLBACK WAS RIGHT AND THE SILENCE WAS NOT. Keeping the visible screen is correct
		 * — a blank sheet would be worse — but the sheet then carried the multiplexer's note, which
		 * tells the reader the history is over there and reachable. It was not: nobody could ask.
		 * Reported from a phone as "the popup has nothing in it", and answered by opening the
		 * dashboard on a desktop, which is the trip this is supposed to save.
		 */
		const surface = fakeSurface();
		surface.setScrollback(false);
		const slot = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const { container } = render(TerminalPane, {
			props: {
				slot,
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				// `null` is the consumer's word for "the ask failed" — a throw is the same answer.
				onReadHistory: vi.fn(async () => null),
			},
		});

		await vi.waitFor(() => expect(surface.written.length).toBeGreaterThan(0));
		(container.querySelector('[data-pdmux-history]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(container.querySelector('[data-pdmux-history-body]')?.textContent).toContain('echo terminal');
		expect(container.querySelector('[data-pdmux-history-note="failed"]')).not.toBeNull();
		expect(container.querySelector('[data-pdmux-history-note="multiplexer"]')).toBeNull();
	});

	it('[TC-PDUI-217] carries "a full-screen program owns this pane" through to the sheet', async () => {
		/**
		 * An empty answer is an ANSWER, not a failure: the multiplexer really has nothing above
		 * the screen because the program is drawing on the alternate one. That is the case a
		 * coding agent creates, it is the case the reader is most likely to hit, and it needs the
		 * one note that does not send them looking for a history nobody kept.
		 */
		const surface = fakeSurface();
		surface.setScrollback(false);
		const slot = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
		const { container } = render(TerminalPane, {
			props: {
				slot,
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onReadHistory: vi.fn(async () => ({ lines: [], scrollback: false, screenOnly: true })),
			},
		});

		await vi.waitFor(() => expect(surface.written.length).toBeGreaterThan(0));
		(container.querySelector('[data-pdmux-history]') as HTMLButtonElement).click();
		await tick();
		await tick();
		// The local screen is still what is shown…
		expect(container.querySelector('[data-pdmux-history-body]')?.textContent).toContain('echo terminal');
		// …and the note is the one that tells the reader where earlier output actually is.
		expect(container.querySelector('[data-pdmux-history-note="screen"]')).not.toBeNull();
	});

	it('zooms on a click and only focuses on a drag, so a selection is not eaten', () => {
		const onZoom = vi.fn();
		const onFocus = vi.fn();
		const surface = fakeSurface();
		const { container } = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'attach', session: 'main' },
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onZoom,
				onFocus,
			},
		});
		// ⚠ DISPATCHED ON THE SURFACE, NOT ON THE GUARD. That is the point of the change:
		// the classification listens on the pane body, so a gesture that begins on the
		// terminal itself is understood. It used to live on a button laid over the surface,
		// which meant this element had no handler at all — and, in a real browser, that the
		// button won the hit test and xterm never saw the press.
		const surfaceEl = container.querySelector('[data-pdmux-surface]') as HTMLElement;
		surfaceEl.dispatchEvent(pointer('pointerdown', 100, 100));
		surfaceEl.dispatchEvent(pointer('pointerup', 101, 100));
		expect(onZoom).toHaveBeenCalledWith('s1');

		surfaceEl.dispatchEvent(pointer('pointerdown', 100, 100));
		surfaceEl.dispatchEvent(pointer('pointerup', 300, 140));
		expect(onFocus).toHaveBeenCalledWith('s1');
		expect(onZoom).toHaveBeenCalledTimes(1);
	});

	it('[TC-PDUI-192] classifies a gesture that starts on the terminal, and forgets a cancelled one', () => {
		/**
		 * REPORTED: dragging in the terminal selected nothing, so nothing could be copied.
		 *
		 * The classifier used to be a transparent `<button>` laid over the surface at
		 * `inset: 0`. It won the hit test on every pane that was not the single focused one
		 * — `focusId` is `null` on a fresh layout, so that was ALL of them — and xterm never
		 * received the press at all. Not cancelled: occluded. Its own handler then classified
		 * the gesture after the fact and, for a drag, merely focused the pane; the comment
		 * said "let the user drag again". The drag the user had just made was thrown away.
		 *
		 * ⚠ THIS SPEC CANNOT PROVE THE OCCLUSION IS GONE — jsdom dispatches events without
		 * hit-testing, so anything aimed at the guard bubbles whatever `pointer-events` says.
		 * What it CAN prove is that the listener moved: an event starting on the surface is
		 * now understood, where before nothing was listening there. The occlusion itself is
		 * proven in a real browser by TC-PDTERM-132/133.
		 */
		const onZoom = vi.fn();
		const onFocus = vi.fn();
		const { container } = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'attach', session: 'main' },
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: fakeSurface().factory,
				onZoom,
				onFocus,
			},
		});
		const surfaceEl = container.querySelector('[data-pdmux-surface]') as HTMLElement;

		// ⚠ A RELEASE THAT NEVER ARRIVES MUST NOT POISON THE NEXT PRESS. The old handler had
		// no `pointercancel` and no pointer capture, so a drag released outside the pane left
		// its `pointerdown` sample behind — and the next click was measured against that stale
		// timestamp, always came out as a drag, and click-to-zoom stopped working entirely.
		surfaceEl.dispatchEvent(pointer('pointerdown', 100, 100));
		surfaceEl.dispatchEvent(pointer('pointercancel', 100, 100));
		expect(onZoom).not.toHaveBeenCalled();
		expect(onFocus).not.toHaveBeenCalled();

		// A clean click right afterwards still zooms, which is what the stale sample broke.
		surfaceEl.dispatchEvent(pointer('pointerdown', 40, 40));
		surfaceEl.dispatchEvent(pointer('pointerup', 41, 40));
		expect(onZoom).toHaveBeenCalledWith('s1');

		// The header runs its own drag-to-move gesture and zooms on its own click. It is a
		// SIBLING of the pane body, so it must be classified ONCE — by itself — and never
		// also by the listener added here.
		onZoom.mockClear();
		const head = container.querySelector('.pdmux-pane-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 10, 10));
		head.dispatchEvent(pointer('pointerup', 11, 10));
		expect(onZoom, 'the header gesture was classified twice').toHaveBeenCalledTimes(1);
	});

	it('[TC-PDUI-192] leaves the pane you are working in alone, and still focuses on a drag', async () => {
		/**
		 * ⚠ BOTH HALVES ARE REGRESSIONS THIS CHANGE NEARLY SHIPPED.
		 *
		 * Listening on the pane body instead of on an overlay means the listener exists on
		 * EVERY pane, including the active one — which has no guard and whose clicks belong
		 * to the program inside it. Ungated, `clickAction` defaults to `zoom`, so clicking
		 * to place a cursor in vim would zoom the pane, and any click in a zoomed pane would
		 * un-zoom it.
		 *
		 * And the focus call must fire for a DRAG too. The drag threshold is 6px, which a
		 * finger crosses on what its owner meant as a tap; a touch drag produces no
		 * compatibility mouse events either, so xterm's own focus-on-mousedown does not run.
		 * Gating focus on `click` silently reinstates "I tapped the pane and no keyboard
		 * appeared" — a bug this codebase has already had once.
		 */
		const onZoom = vi.fn();
		const onFocus = vi.fn();
		const surface = fakeSurface();
		const focused = vi.spyOn(surface.factory(), 'focus');

		const active = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'attach', session: 'main' },
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				focused: true,
				onZoom,
				onFocus,
			},
		});
		const liveSurface = active.container.querySelector('[data-pdmux-surface]') as HTMLElement;
		liveSurface.dispatchEvent(pointer('pointerdown', 60, 60));
		window.dispatchEvent(pointer('pointerup', 61, 60));
		expect(onZoom, 'a click in the pane being worked in toggled zoom').not.toHaveBeenCalled();
		expect(onFocus).not.toHaveBeenCalled();

		cleanup();

		// A guarded pane, dragged: it must still take focus, or a phone gets no keyboard.
		const guardedPane = render(TerminalPane, {
			props: {
				slot: { id: 's2', hostId: 'h1', kind: 'attach', session: 'main' },
				index: 0,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onZoom,
				onFocus,
			},
		});
		// ⚠ WAIT FOR THE SURFACE TO EXIST. It is created in an async effect, and `paneUp`
		// calls `surface?.focus()` — dispatching before then asserts nothing at all.
		await vi.waitFor(() => expect(surface.written.length).toBeGreaterThan(0));
		const guardedSurface = guardedPane.container.querySelector('[data-pdmux-surface]') as HTMLElement;
		guardedSurface.dispatchEvent(pointer('pointerdown', 100, 100));
		window.dispatchEvent(pointer('pointerup', 160, 140));
		expect(onFocus, 'a drag did not focus the pane').toHaveBeenCalledWith('s2');
		expect(focused, 'the surface was never focused, so a phone would show no keyboard').toHaveBeenCalled();
	});

	it('reports a header drag so the grid can hit-test the cells', () => {
		const onDragStart = vi.fn();
		const onDragEnd = vi.fn();
		const onZoom = vi.fn();
		const surface = fakeSurface();
		const { container } = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'attach', session: 'main' },
				index: 3,
				hostName: 'alpha',
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				onDragStart,
				onDragEnd,
				onZoom,
			},
		});
		const header = container.querySelector('.pdmux-pane-head') as HTMLElement;
		header.dispatchEvent(pointer('pointerdown', 10, 10));
		// NOT on pointerdown: the gesture is not a drag until it moves like one, and
		// announcing it early is what left clicked panes dimmed forever.
		expect(onDragStart).not.toHaveBeenCalled();
		header.dispatchEvent(pointer('pointermove', 400, 200));
		expect(onDragStart).toHaveBeenCalledWith(3);
		expect(onDragStart).toHaveBeenCalledTimes(1);
		header.dispatchEvent(pointer('pointermove', 402, 201));
		expect(onDragStart).toHaveBeenCalledTimes(1); // announced once per gesture
		header.dispatchEvent(pointer('pointerup', 400, 200));
		expect(onDragEnd).toHaveBeenCalledWith(3, { x: 400, y: 200 });
		expect(onZoom).not.toHaveBeenCalled(); // a drag is not a zoom

		// A short press on the header is still the zoom toggle, and starts no drag.
		header.dispatchEvent(pointer('pointerdown', 10, 10));
		header.dispatchEvent(pointer('pointerup', 11, 10));
		expect(onZoom).toHaveBeenCalledWith('s1');
		expect(onDragStart).toHaveBeenCalledTimes(1);
		expect(onDragEnd).toHaveBeenCalledTimes(1);
	});

	it('[TC-PDUI-017] leaves no drag state behind after a click or a cancelled drag', async () => {
		// THE REGRESSION: `.pdmux-dragging` dims a pane by design WHILE it is dragged, but
		// a plain click used to enter that state and never leave it, so the terminal sat
		// under a grey veil until something else re-rendered it. Reported as exactly that.
		const layout = layoutWith({ clickAction: 'focus' });
		const { container } = render(TerminalGrid, {
			props: {
				layout,
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: fakeSurface().factory,
				sweepMs: 0,
			},
		});
		const header = container.querySelector('.pdmux-pane-head') as HTMLElement;
		const dimmed = (): number => container.querySelectorAll('.pdmux-pane.pdmux-dragging').length;

		header.dispatchEvent(pointer('pointerdown', 10, 10));
		header.dispatchEvent(pointer('pointerup', 11, 10));
		await tick();
		expect(dimmed(), 'a click must not dim the pane').toBe(0);

		// A real drag dims while it lasts…
		header.dispatchEvent(pointer('pointerdown', 10, 10));
		header.dispatchEvent(pointer('pointermove', 300, 180));
		await tick();
		expect(dimmed()).toBe(1);
		// …and a cancelled gesture (pointer capture revoked, window blurred) still ends it.
		header.dispatchEvent(pointer('pointercancel', 300, 180));
		await tick();
		expect(dimmed(), 'a cancelled drag must not leave a pane dimmed').toBe(0);

		// A press that never moves reaches pointerup with no drag to end.
		header.dispatchEvent(pointer('pointerdown', 10, 10));
		header.dispatchEvent(pointer('pointerup', 10, 10));
		await tick();
		expect(dimmed()).toBe(0);
	});

	it('[TC-PDUI-017] marks the active pane on its frame, and only that pane', () => {
		const focusId = buildDefaultSlots(HOSTS, { pad: 2 })[1]?.id ?? '';
		const { container } = render(TerminalGrid, {
			props: {
				layout: layoutWith({ focusId }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: fakeSurface().factory,
				sweepMs: 0,
			},
		});
		const marked = [...container.querySelectorAll('[data-pdmux-focused="true"]')].map((n) => n.getAttribute('data-pdmux-pane'));
		expect(marked).toEqual([focusId]);
		// The mark is on the frame; nothing is added over the surface (that is what the
		// stuck dim did, and it made the terminal unreadable).
		const pane = container.querySelector(`[data-pdmux-pane="${focusId}"]`) as HTMLElement;
		expect(pane.classList.contains('pdmux-focused')).toBe(true);
		expect(pane.querySelector('[data-pdmux-guard]'), 'an active pane takes typing directly').toBeNull();

		// A zoomed pane reads as active too — it behaves that way already.
		const zoomed = render(TerminalGrid, {
			props: {
				layout: layoutWith({ zoomId: focusId }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: fakeSurface().factory,
				sweepMs: 0,
			},
		});
		expect(zoomed.container.querySelector(`[data-pdmux-pane="${focusId}"]`)?.getAttribute('data-pdmux-focused')).toBe('true');
	});
});

describe('[TC-PDUI-013] a pane speaks to an injected adapter, not to a transport', () => {
	it('opens the slot target, prints what arrives and sends what is typed', async () => {
		const surface = fakeSurface();
		const echo = new EchoTerminalAdapter();
		const open = vi.spyOn(echo, 'open');
		const { unmount } = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'new', session: 'w1' },
				index: 0,
				hostName: 'alpha',
				adapter: echo,
				createSurface: surface.factory,
			},
		});
		await vi.waitFor(() => expect(open).toHaveBeenCalled());
		// `attach` and `new` collapse into one wire kind; the geometry comes from the
		// surface, not from a guess.
		expect(open.mock.calls[0]?.[0]).toEqual({
			slotId: 's1',
			hostId: 'h1',
			kind: 'session',
			session: 'w1',
			cols: 80,
			rows: 24,
		});
		await vi.waitFor(() => expect(surface.written.join('')).toContain('pdmux echo terminal'));
		surface.type('ls');
		await vi.waitFor(() => expect(surface.written.join('')).toContain('ls'));
		unmount();
		expect(surface.disposed()).toBe(1);
	});

	it('survives a surface that cannot render', async () => {
		const echo = new EchoTerminalAdapter();
		const open = vi.spyOn(echo, 'open');
		const { container } = render(TerminalPane, {
			props: {
				slot: { id: 's1', hostId: 'h1', kind: 'shell', session: null },
				index: 0,
				hostName: 'alpha',
				adapter: echo,
				createSurface: () => {
					throw new Error('no canvas');
				},
			},
		});
		// The rest of the grid must keep working: the pane renders, it just has no
		// terminal in it.
		await vi.waitFor(() => expect(container.querySelector('[data-pdmux-surface]')).not.toBeNull());
		expect(open).not.toHaveBeenCalled();
	});
});

/**
 * The composer is the only way to type Korean/Japanese/Chinese at a terminal (a mobile IME
 * cannot be trusted in xterm's hidden textarea — pdmux-work/docs/IME_INPUT.md), so "when is it there"
 * is a product contract and not a detail. It used to require `focused || zoomed`; on a phone
 * nothing is focused until a finger lands, so the one path that works was hidden behind a
 * tap. The matrix below is the fix: device gate x on-screen x (single cell or chosen).
 */
describe('[TC-PDTERM-131] the touch bars follow the pane ON SCREEN, not the focus', () => {
	const paneProps = (over: Record<string, unknown> = {}) => ({
		slot: { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' },
		index: 0,
		hostName: 'alpha',
		adapter: new EchoTerminalAdapter(),
		createSurface: fakeSurface().factory,
		// A touch device showing one pane, which is what a phone is.
		keyBar: true,
		solo: true,
		focused: false,
		...over,
	});

	const bars = (container: HTMLElement): { composer: boolean; keys: boolean } => ({
		composer: container.querySelector('[data-pdmux-composer]') !== null,
		keys: container.querySelector('[data-pdmux-keys]') !== null,
	});

	it('renders on an UNFOCUSED single pane — a phone focuses nothing until a tap', () => {
		const { container } = render(TerminalPane, { props: paneProps() });
		expect(bars(container)).toEqual({ composer: true, keys: true });
		// Both send on the pane's own connection, so neither ever needed the keyboard focus…
		// and the tap-to-focus guard is untouched, because that gesture is what raises the
		// software keyboard.
		expect(container.querySelector('[data-pdmux-guard]')).not.toBeNull();
	});

	it('stays off a desktop pane that is merely visible', () => {
		const { container } = render(TerminalPane, { props: paneProps({ keyBar: false, focused: true }) });
		expect(bars(container)).toEqual({ composer: false, keys: false });
	});

	it('still asks for focus where several panes share the screen', () => {
		const split = render(TerminalPane, { props: paneProps({ solo: false }) });
		expect(bars(split.container), 'in a split, "which terminal does this type into" is a real question').toEqual({
			composer: false,
			keys: false,
		});
		const chosen = render(TerminalPane, { props: paneProps({ solo: false, focused: true }) });
		expect(bars(chosen.container)).toEqual({ composer: true, keys: true });
	});

	it('renders none on a pane that is off the page or behind another tab', () => {
		// A paged-away pane stays MOUNTED so its session survives; a second (hidden) input
		// field is still an input field.
		expect(bars(render(TerminalPane, { props: paneProps({ visible: false }) }).container)).toEqual({
			composer: false,
			keys: false,
		});
		expect(bars(render(TerminalPane, { props: paneProps({ onScreen: false }) }).container)).toEqual({
			composer: false,
			keys: false,
		});
	});

	it('leaves the tap-to-focus guard doing its job — that gesture is what opens a keyboard', async () => {
		const focus = vi.fn();
		const base = fakeSurface();
		const onZoom = vi.fn();
		const { container } = render(TerminalPane, {
			props: paneProps({ createSurface: () => ({ ...base.factory(), focus }), onZoom }),
		});
		// The bars are up, and the pane is still guarded: showing them early must not cost the
		// tap that hands the terminal its focus.
		await vi.waitFor(() => expect(base.written.join('')).toContain('pdmux echo terminal'));
		expect(bars(container)).toEqual({ composer: true, keys: true });
		const guard = container.querySelector('[data-pdmux-guard]') as HTMLElement;
		guard.dispatchEvent(pointer('pointerdown', 40, 40));
		guard.dispatchEvent(pointer('pointerup', 41, 40));
		// A mobile browser only opens the keyboard for a programmatic focus made INSIDE a user
		// gesture, so this call is the whole reason a tap works.
		expect(focus, 'the one focus call a phone answers with a keyboard').toHaveBeenCalled();
		expect(onZoom).toHaveBeenCalledWith('s1');
	});

	it('takes "single cell" from the grid window, so one composer exists at a time', async () => {
		const gridProps = (layout: TerminalLayout) => ({
			layout,
			hosts: HOSTS,
			adapter: new EchoTerminalAdapter(),
			createSurface: fakeSurface().factory,
			keyBar: true,
			sweepMs: 0,
		});
		// `tab` is what a phone's shell projects (`soloLayout`): one cell, so no tap needed.
		const solo = render(TerminalGrid, { props: gridProps(layoutWith({ mode: 'tab' })) });
		await tick();
		expect(solo.container.querySelectorAll('[data-pdmux-composer]')).toHaveLength(1);

		// The user's own 2x2 on a touch screen: the chosen pane, and only it.
		const focusId = buildDefaultSlots(HOSTS, { pad: 2 })[1]?.id ?? '';
		const split = render(TerminalGrid, { props: gridProps(layoutWith({ mode: 'split4', focusId })) });
		await tick();
		const marked = [...split.container.querySelectorAll('[data-pdmux-composer]')].map(
			(node) => node.closest('[data-pdmux-pane]')?.getAttribute('data-pdmux-pane'),
		);
		expect(marked).toEqual([focusId]);
	});
});

describe('[TC-PDUI-014] the picker offers attach, new and shell', () => {
	it('reports the chosen target with the cell it was opened from', () => {
		const onApply = vi.fn();
		const { container } = render(TerminalTargetPicker, {
			props: { hosts: HOSTS, index: 2, hostId: 'h1', onApply },
		});
		(container.querySelector('[data-pdmux-session="main"]') as HTMLElement).click();
		expect(onApply).toHaveBeenCalledWith({ hostId: 'h1', kind: 'attach', session: 'main' }, 2);

		(container.querySelector('[data-pdmux-action="new"]') as HTMLElement).click();
		// The suggested name is the lowest free one for that host.
		expect(onApply).toHaveBeenLastCalledWith({ hostId: 'h1', kind: 'new', session: 'w1' }, 2);

		(container.querySelector('[data-pdmux-action="shell"]') as HTMLElement).click();
		expect(onApply).toHaveBeenLastCalledWith({ hostId: 'h1', kind: 'shell', session: null }, 2);
	});

	it('disables an unreachable host and says when a host has no sessions', () => {
		const onCancel = vi.fn();
		const { container } = render(TerminalTargetPicker, {
			props: { hosts: [HOSTS[1]!], index: null, onCancel },
		});
		expect((container.querySelector('[data-pdmux-host="h2"]') as HTMLButtonElement).disabled).toBe(true);
		expect(container.querySelector('[data-pdmux-empty="sessions"]')).not.toBeNull();
		(container.querySelector('[data-pdmux-action="cancel"]') as HTMLElement).click();
		expect(onCancel).toHaveBeenCalled();
	});

});

describe('[TC-PDUI-018] the picker does not offer what the host cannot do', () => {
	it('[TC-PDUI-018] stops offering sessions on a host that has no multiplexer', () => {
		const onApply = vi.fn();
		const { container } = render(TerminalTargetPicker, {
			props: {
				hosts: [{ id: 'h3', name: 'gamma', online: true, sessions: [], multiplexer: false }],
				index: 0,
				onApply,
			},
		});

		// It used to read "No sessions running" — identical to a host whose sessions
		// had merely exited — and the only way to learn the difference was to click
		// "New session" and read the agent's refusal.
		expect(container.querySelector('[data-pdmux-empty="sessions"]')?.textContent).toContain('multiplexer');

		const create = container.querySelector('[data-pdmux-action="new"]') as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		create.click();
		expect(onApply).not.toHaveBeenCalled();

		// The shell is not disabled with it: no multiplexer is not no terminal.
		const shell = container.querySelector('[data-pdmux-action="shell"]') as HTMLButtonElement;
		expect(shell.disabled).toBe(false);
		shell.click();
		expect(onApply).toHaveBeenCalledWith({ hostId: 'h3', kind: 'shell', session: null }, 0);
	});

	it('[TC-PDUI-018] leaves a host that never said anything alone', () => {
		// The control, and the compatibility case: every producer of this shape
		// predates the field. Absence of evidence must not take session targets away.
		const { container } = render(TerminalTargetPicker, {
			props: { hosts: HOSTS, index: 0, hostId: 'h1' },
		});
		expect((container.querySelector('[data-pdmux-action="new"]') as HTMLButtonElement).disabled).toBe(false);
		expect(container.querySelector('[data-pdmux-session="main"]')).not.toBeNull();
	});
});

describe('[TC-PDUI-014] the picker validates a session name before the server has to', () => {
	it('refuses a session name the server would reject', async () => {
		const onApply = vi.fn();
		const { container } = render(TerminalTargetPicker, {
			props: { hosts: HOSTS, index: 0, hostId: 'h1', onApply },
		});
		const input = container.querySelector('input[type="text"]') as HTMLInputElement;
		input.value = 'not a valid name!';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.waitFor(() => expect((container.querySelector('[data-pdmux-action="new"]') as HTMLButtonElement).disabled).toBe(true));
		(container.querySelector('[data-pdmux-action="new"]') as HTMLElement).click();
		expect(onApply).not.toHaveBeenCalled();
	});
});

describe('[TC-PDUI-015] a splitter drag survives crossing an embedded surface', () => {
	it('captures the pointer instead of listening on the document', async () => {
		const { default: SplitHandle } = await import('../src/components/SplitHandle.svelte');
		const onDrag = vi.fn();
		const onCommit = vi.fn();
		const { container } = render(SplitHandle, { props: { onDrag, onCommit } });
		const handle = container.querySelector('[data-pdmux-handle]') as HTMLElement;
		// Capture is the whole point: a document-level listener stops hearing the drag
		// the moment the pointer enters an embedded surface.
		const capture = vi.fn();
		(handle as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture = capture;
		(handle as HTMLElement & { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => undefined;
		handle.dispatchEvent(pointer('pointerdown', 300, 10));
		expect(capture).toHaveBeenCalled();
		handle.dispatchEvent(pointer('pointermove', 360, 10));
		expect(onDrag).toHaveBeenCalledWith(60);
		handle.dispatchEvent(pointer('pointerup', 380, 10));
		expect(onCommit).toHaveBeenCalledWith(80);

		// A right-hand dock grows leftwards, so its handle negates the delta.
		const inverted = render(SplitHandle, { props: { invert: true, onCommit } });
		const other = inverted.container.querySelector('[data-pdmux-handle]') as HTMLElement;
		other.dispatchEvent(pointer('pointerdown', 300, 10));
		other.dispatchEvent(pointer('pointerup', 260, 10));
		expect(onCommit).toHaveBeenLastCalledWith(40);
	});
});

describe('[TC-PDUI-016] a hydrated layout renders the same grid it was saved from', () => {
	it('round-trips through persistence without moving a cell', async () => {
		const surface = fakeSurface();
		const saved = layoutWith({ mode: 'split4', page: 0 });
		const hydrated = normalizeLayout(JSON.parse(JSON.stringify(saved)), HOSTS);
		const { container } = render(TerminalGrid, {
			props: {
				layout: hydrated,
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface.factory,
				sweepMs: 0,
			},
		});
		await vi.waitFor(() => expect(container.querySelectorAll('[data-pdmux-cell]').length).toBe(4));
		const labels = [...container.querySelectorAll('.pdmux-pane-label')].map((n) => n.textContent?.trim());
		expect(labels[0]).toContain('alpha·main');
		// Ids stay unique across the reload, or two cells would resolve to one pane.
		const ids = [...container.querySelectorAll('[data-pdmux-pane]')].map((n) => n.getAttribute('data-pdmux-pane'));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

/**
 * Last in the file on purpose: this is the one block that swaps a module out from under
 * the factory, and `vi.resetModules()` would otherwise hand the Svelte tests above a
 * second copy of the component modules.
 */
describe('[TC-PDUI-048] the terminal opens on the previous client’s palette, not pure black', () => {
	afterEach(() => {
		vi.doUnmock('@xterm/xterm');
		vi.doUnmock('@xterm/addon-fit');
		vi.resetModules();
	});

	it('[TC-PDUI-048] carries the colours the previous client actually served', async () => {
		const { TERMINAL_THEME } = await import('../src/adapters/terminal-surface.js');
		// Read out of the client this product replaced: its own default terminal options.
		expect(TERMINAL_THEME.background).toBe('#2b2b2b');
		expect(TERMINAL_THEME.foreground).toBe('#d2d2d2');
		expect(TERMINAL_THEME.cursor).toBe('#adadad');
		// The regression being locked: xterm's stock background is what looked harsh.
		expect(TERMINAL_THEME.background).not.toBe('#000000');
		// Every ANSI slot must be named, or one program's output falls back to xterm's
		// stock palette while the rest uses the previous client's and the two stop matching.
		const ansi = [
			'black',
			'red',
			'green',
			'yellow',
			'blue',
			'magenta',
			'cyan',
			'white',
			'brightBlack',
			'brightRed',
			'brightGreen',
			'brightYellow',
			'brightBlue',
			'brightMagenta',
			'brightCyan',
			'brightWhite',
		] as const;
		for (const slot of ansi) expect(TERMINAL_THEME[slot]).toMatch(/^#[0-9a-f]{6}$/);
		// Selection has to stay readable on the lighter background: white at 30% over
		// #2b2b2b composites to ~#6b6b6b, which #d2d2d2 text still clears.
		expect(TERMINAL_THEME.selectionBackground).toBe('rgba(255, 255, 255, 0.3)');
	});

	it('[TC-PDUI-048] hands that exact theme to xterm when it builds a surface', async () => {
		const built: Record<string, unknown>[] = [];
		// A fake xterm rather than a fake surface: the point of this case is the options
		// the factory constructs with, which a stubbed surface replaces wholesale. jsdom
		// has no canvas, so the real Terminal cannot be opened here either.
		vi.doMock('@xterm/xterm', () => ({
			Terminal: class {
				cols = 80;
				rows = 24;
				constructor(options: Record<string, unknown>) {
					built.push(options);
				}
				loadAddon(): void {}
				open(): void {}
				attachCustomKeyEventHandler(): void {}
				attachCustomWheelEventHandler(): void {}
				scrollLines(): void {}
				onSelectionChange(): { dispose(): void } {
					return { dispose(): void {} };
				}
				onData(): { dispose: () => void } {
					return { dispose: () => undefined };
				}
				getSelection(): string {
					return '';
				}
				write(): void {}
				input(): void {}
				focus(): void {}
				dispose(): void {}
			},
		}));
		vi.doMock('@xterm/addon-fit', () => ({
			FitAddon: class {
				fit(): void {}
			},
		}));
		vi.resetModules();
		const { createXtermSurface, TERMINAL_THEME, TERMINAL_FONT_SIZE } = await import('../src/adapters/terminal-surface.js');
		const surface = await createXtermSurface(document.createElement('div'));
		expect(built).toHaveLength(1);
		expect(built[0]?.theme).toEqual(TERMINAL_THEME);
		// The same evidence gives the size, so it is asserted from the same place.
		expect(built[0]?.fontSize).toBe(TERMINAL_FONT_SIZE);
		expect(TERMINAL_FONT_SIZE).toBe(13);
		surface.dispose();
	});

	it('[TC-PDUI-048] paints the pane behind the canvas the same colour', async () => {
		const { TERMINAL_THEME } = await import('../src/adapters/terminal-surface.js');
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const { join, dirname } = await import('node:path');
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'), 'utf8');
		// Two declarations in two languages have to agree, so the agreement is asserted
		// rather than left to a comment: xterm repaints on every resize, and a pane
		// painted a different colour flashes a seam along the edge being dragged.
		expect(css).toContain(`--pdmux-term-bg: ${TERMINAL_THEME.background};`);
		expect(css).toMatch(/\.pdmux-pane-body\s*\{[^}]*background:\s*var\(--pdmux-term-bg\)/);
	});
});

/**
 * The two scroll buttons, and the gate that used to switch them off.
 *
 * REPORTED FROM A PHONE: "they do nothing, and they disappear the moment I press them."
 * Both halves had the same root — `canScroll` was read ONLY from inside `scrollPane`, i.e.
 * by the very press it gated — so a pane attached to a multiplexer drew buttons it believed
 * could not scroll, ignored the tap, and latched them off for the rest of the pane's life.
 * The gesture the buttons stand for is pinned in `terminal-scroll.test.ts`; this is the
 * wiring: WHEN the pane draws them, and when it stops.
 */
describe('[TC-PDUI-196] the scroll buttons follow the buffer, and outlive the press', () => {
	const paneProps = (over: Record<string, unknown> = {}) => ({
		slot: { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' },
		index: 0,
		hostName: 'alpha',
		adapter: new EchoTerminalAdapter(),
		// A touch device showing one pane, which is what a phone is.
		keyBar: true,
		solo: true,
		focused: false,
		...over,
	});

	const scrollButtons = (container: HTMLElement): number => container.querySelectorAll('[data-pdmux-scroll]').length;

	it('never draws a button the first press would delete', async () => {
		/**
		 * THE FIRST HALF OF THE REPORT, AND THE ONE THAT MAKES THE SECOND POSSIBLE. A pane whose
		 * surface says it cannot scroll must not draw the buttons at all — reproduced live at
		 * `1 present, 0 frames sent, 0 present`. Under the old code the seed `true` put them on
		 * screen and only the press ever asked, so the tap they were waiting for was also the
		 * tap that removed them.
		 */
		const base = fakeSurface();
		base.setScrollable(false);
		const { container } = render(TerminalPane, { props: paneProps({ createSurface: base.factory }) });
		await vi.waitFor(() => expect(base.written.join('')).toContain('pdmux echo terminal'));
		expect(scrollButtons(container), 'buttons were drawn on a pane that cannot scroll').toBe(0);
	});

	it('still has both buttons after a press that reached the surface', async () => {
		// The user-facing statement, plainly. What MAKES it true is the case above and the case
		// below — the gate is asked before the press rather than by it — so this reads as the
		// report's own words and leans on those two for its guarantee.
		const base = fakeSurface();
		const { container } = render(TerminalPane, { props: paneProps({ createSurface: base.factory }) });
		await vi.waitFor(() => expect(base.written.join('')).toContain('pdmux echo terminal'));
		expect(scrollButtons(container), 'a scrollable pane draws both buttons').toBe(2);

		const up = container.querySelector('[data-pdmux-scroll="up"]') as HTMLElement;
		up.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
		// It reached the surface…
		expect(base.scrolled).toEqual([-1]);
		// …and it is still there to be pressed again.
		expect(scrollButtons(container), 'the press took the buttons with it').toBe(2);
	});

	it('drops them when the wheel stops reaching anything, and brings them back', async () => {
		const base = fakeSurface();
		const { container } = render(TerminalPane, { props: paneProps({ createSurface: base.factory }) });
		await vi.waitFor(() => expect(base.written.join('')).toContain('pdmux echo terminal'));
		expect(scrollButtons(container)).toBe(2);

		// A pane runs into and out of these states while it is open: a program starts, takes the
		// screen, gives it back. Each transition ARRIVES as output, which is where the pane asks
		// again — so typing a byte and letting the echo come back is the real path, not a poke.
		base.setScrollable(false);
		base.type('x');
		await vi.waitFor(() => expect(scrollButtons(container)).toBe(0));

		base.setScrollable(true);
		base.type('y');
		// ⚠ THIS IS THE DIRECTION THE OLD CODE COULD NOT GO. The only thing that could set the
		// gate true again was a handler on the buttons that had just been removed.
		await vi.waitFor(() => expect(scrollButtons(container)).toBe(2));
	});
});
