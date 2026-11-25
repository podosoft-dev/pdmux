/**
 * A pane focused in the window in use takes its shared native screen back.
 *
 * A native session has one screen, sized to the viewer that last typed into or resized it.
 * With the same pane open in two windows, working in one and coming back to the other left
 * the second on the first one's screen — content in a corner, or cut off — until somebody
 * typed there. Focus is when a person starts using a pane, so focus claims; a background tab
 * never does.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { TerminalSlot } from '@pdmux/core';
import type { TerminalConnection, TerminalOpenTarget } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import TerminalPane from '../src/components/TerminalPane.svelte';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

const SESSION = 'c1a10000-0000-4000-8000-000000000001';
const NATIVE: TerminalSlot = { id: 's1', hostId: 'h1', kind: 'attach', backend: 'native', session: 'w2', sessionId: SESSION, intent: 'attach' };

function surface(): TerminalSurface {
	return {
		write: () => undefined,
		fit: () => ({ cols: 80, rows: 24 }),
		focus: () => undefined,
		scrollPages: () => undefined,
		canScroll: () => false,
		readHistory: () => ({ lines: [], scrollback: false }),
		onScrollbackRequest: () => () => undefined,
		onGesture: () => () => undefined,
		onData: () => () => undefined,
		dispose: () => undefined,
	};
}

/** An adapter that counts claims and lets the test report a (re)attach. */
function host(): { adapter: { open: (target: TerminalOpenTarget) => TerminalConnection }; claims: () => number; attached: () => void; opened: () => number } {
	let claims = 0;
	let opened = 0;
	const session = new Set<(id: string) => void>();
	return {
		claims: () => claims,
		opened: () => opened,
		attached: () => { for (const listener of session) listener(SESSION); },
		adapter: {
			open: () => {
				opened += 1;
				return {
					send: () => undefined,
					resize: () => undefined,
					claim: () => { claims += 1; },
					onData: () => () => undefined,
					onExit: () => () => undefined,
					onSession: (listener) => { session.add(listener); return () => session.delete(listener); },
					close: () => undefined,
				};
			},
		},
	};
}

/** The pane, with a focusable element inside its surface the way xterm's input textarea is. */
async function mount(windowFocused: boolean) {
	const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(windowFocused);
	const native = host();
	const { container } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface } });
	await vi.waitFor(() => expect(native.opened()).toBe(1));
	const surfaceHost = container.querySelector('[data-pdmux-surface]') as HTMLElement;
	const input = document.createElement('textarea');
	surfaceHost.appendChild(input);
	const outside = document.createElement('button');
	document.body.appendChild(outside);
	// Subscribing to the session may replay a known id; nothing is focused yet, so no claim.
	return { native, input, outside, hasFocus, baseline: native.claims() };
}

it('[TC-PDTERM-180] focusing the pane in a focused window claims the screen', async () => {
	const { native, input, baseline } = await mount(true);
	expect(baseline).toBe(0);
	input.focus();
	expect(native.claims()).toBe(1);
});

it('[TC-PDTERM-180] the window coming back claims only for the pane that holds the focus', async () => {
	const { native, input, outside, hasFocus } = await mount(true);
	input.focus();
	const afterFocus = native.claims();
	// Another window was in use; this one comes back with the pane still focused.
	hasFocus.mockReturnValue(true);
	window.dispatchEvent(new Event('focus'));
	expect(native.claims()).toBe(afterFocus + 1);
	// Focus elsewhere in the page: the window coming back is not this pane being used.
	outside.focus();
	window.dispatchEvent(new Event('focus'));
	expect(native.claims()).toBe(afterFocus + 1);
});

it('[TC-PDTERM-180] a reattach claims while the pane is focused, and a background tab never claims', async () => {
	const focused = await mount(true);
	focused.input.focus();
	const afterFocus = focused.native.claims();
	focused.native.attached();
	expect(focused.native.claims()).toBe(afterFocus + 1);
	cleanup();
	vi.restoreAllMocks();
	document.body.innerHTML = '';

	const background = await mount(false);
	background.input.focus();
	window.dispatchEvent(new Event('focus'));
	background.native.attached();
	expect(background.native.claims()).toBe(0);
});
