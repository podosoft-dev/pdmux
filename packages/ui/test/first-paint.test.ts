// @vitest-environment node
/**
 * What reaches the browser BEFORE hydration.
 *
 * This file exists in its own environment on purpose. The rest of the suite runs in
 * jsdom, where `@testing-library/svelte`'s `render` flushes effects synchronously —
 * so a component that only fills itself in from an `$effect` looks identical to one
 * that is correct on the first render, and every existing case here passed while the
 * grid was painting empty. A server render runs NO effects, which is exactly the
 * condition the defect lived in.
 *
 * The regression: `TerminalGrid`'s `mounted` list started empty and was populated by an
 * effect. First paint therefore contained only the EMPTY cells, and CSS Grid — handed
 * three children instead of nine — collapsed to three full-height columns. The correct
 * grid arrived ~400ms later. Users saw "the layout is wrong after a refresh, and
 * switching tabs fixes it"; on a phone, the whole split flashed before collapsing to
 * one pane.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { type GridHost, type TerminalLayout, buildDefaultSlots, defaultLayout } from '@pdmux/core';
import { EchoTerminalAdapter } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import TerminalGrid from '../src/components/TerminalGrid.svelte';

const HOSTS: GridHost[] = [
	{ id: 'h1', name: 'alpha', online: true, sessions: [{ name: 'main', attached: 1, windows: 2 }] },
	{ id: 'h2', name: 'beta', online: false, sessions: [] },
];

const surface = (): TerminalSurface => ({
	write: () => undefined,
	fit: () => ({ cols: 80, rows: 24 }),
	focus: () => undefined,
	onData: () => () => undefined,
	dispose: () => undefined,
	scrollPages: () => undefined,
	canScroll: () => true,
	onScrollbackRequest: () => () => undefined,
		onGesture: () => () => undefined,
	readHistory: () => ({ lines: [], scrollback: true }),
});

const layoutWith = (over: Partial<TerminalLayout> = {}): TerminalLayout => ({
	...defaultLayout(),
	slots: buildDefaultSlots(HOSTS, { pad: 2 }),
	...over,
});

const count = (html: string, attribute: string): number => (html.match(new RegExp(attribute, 'g')) ?? []).length;

describe('[TC-PDUI-168] the first paint already contains the panes', () => {
	it('renders every filled cell server-side, not only the empty ones', () => {
		const html = render(TerminalGrid, {
			props: {
				layout: layoutWith({ mode: 'split4' }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface,
				sweepMs: 0,
			},
		}).body;

		// Three terminals and one empty cell — the same grid hydration settles on.
		expect(count(html, 'data-pdmux-pane=')).toBe(3);
		expect(count(html, 'data-pdmux-cell=')).toBe(4);
	});

	it('renders one pane for a single-cell (phone) projection', () => {
		const html = render(TerminalGrid, {
			props: {
				layout: layoutWith({ mode: 'tab' }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface,
				sweepMs: 0,
			},
		}).body;

		expect(count(html, 'data-pdmux-cell=')).toBe(1);
		expect(count(html, 'data-pdmux-pane=')).toBe(1);
	});
});

describe('[TC-PDUI-172] the server marks the stack anchor, so a narrow screen paints one cell', () => {
	/**
	 * The narrow-screen projection is JavaScript, so when the server guesses the device
	 * wrong (a resized window, a responsive-mode tab — no request hint can know), the
	 * full split arrives and used to flash before collapsing at hydration. The grid now
	 * marks the anchor cell and the stylesheet shows only that cell below the stack
	 * breakpoint — meaning the marking must ALREADY be in the server's HTML. That is
	 * what is pinned here; the visual half lives in the browser geometry spec.
	 */
	it('emits exactly one anchor among a multi-cell window', () => {
		const html = render(TerminalGrid, {
			props: {
				layout: layoutWith({ mode: 'split4' }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface,
				sweepMs: 0,
			},
		}).body;

		expect(count(html, 'data-pdmux-stack="anchor"')).toBe(1);
		expect(count(html, 'data-pdmux-stack="rest"')).toBe(3);
	});

	it('marks everything anchor in a single-cell window, so nothing can hide', () => {
		// A phone's projected layout has a window of one; if that one cell were ever
		// marked "rest", the stylesheet would blank the only pane on screen.
		const html = render(TerminalGrid, {
			props: {
				layout: layoutWith({ mode: 'tab' }),
				hosts: HOSTS,
				adapter: new EchoTerminalAdapter(),
				createSurface: surface,
				sweepMs: 0,
			},
		}).body;

		expect(count(html, 'data-pdmux-stack="rest"')).toBe(0);
	});
});
