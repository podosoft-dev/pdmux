/**
 * A pane whose terminal ended because its host went away comes back with the host.
 *
 * Powering a machine off or rebooting it ends its terminals for real — the relay reports
 * `exit` — and the pane used to stay dark until somebody reloaded the page, while every
 * pane that had merely lost its socket reattached by itself. The rule under test is the
 * narrow one: reopen only when the host has been unreachable since the ending, so a
 * program that exits on a healthy host is left as it ended.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	TerminalAdapter,
	TerminalConnection,
	TerminalOpenTarget,
} from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import { tick } from 'svelte';
import { type TerminalLayout, defaultLayout } from '@pdmux/core';
import ReachabilityHarness from './ReachabilityHarness.svelte';

afterEach(cleanup);

/** An adapter whose terminals end when the test says so. */
class ScriptedAdapter implements TerminalAdapter {
	readonly opened: TerminalOpenTarget[] = [];
	private readonly endings: Array<(code: number | null) => void> = [];

	open(target: TerminalOpenTarget): TerminalConnection {
		this.opened.push(target);
		const exits = new Set<(code: number | null) => void>();
		this.endings.push((code) => {
			for (const listener of exits) listener(code);
		});
		return {
			send: () => undefined,
			resize: () => undefined,
			onData: () => () => undefined,
			onExit: (listener) => {
				exits.add(listener);
				return () => exits.delete(listener);
			},
			close: () => undefined,
		};
	}

	/** End the most recently opened terminal, the way a host shutting down does. */
	endLatest(code: number | null = 0): void {
		this.endings.at(-1)?.(code);
	}
}

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

const LAYOUT: TerminalLayout = {
	...defaultLayout(),
	mode: 'tab',
	slots: [{ id: 's1', hostId: 'h1', kind: 'attach', session: 'main' }],
};

/**
 * Through the grid, with reachability held in one signal as the app's feed holds it. The
 * test renderer's `rerender` replaces the whole props object, so flipping reachability that
 * way would also re-deliver the slot — a retarget — and prove nothing about this rule.
 */
async function mount(adapter: ScriptedAdapter, onExit = vi.fn()) {
	const control: { setOnline?: (online: boolean) => void } = {};
	render(ReachabilityHarness, { props: { layout: LAYOUT, adapter, createSurface: surface, onExit, control } });
	await vi.waitFor(() => expect(adapter.opened).toHaveLength(1));
	return {
		reachable: async (online: boolean): Promise<void> => {
			control.setOnline?.(online);
			await tick();
		},
	};
}

describe('[TC-PDVM-022] a pane that ended with its host opens again when the host returns', () => {
	it('reopens the same target after the host was unreachable and is reachable again', async () => {
		const adapter = new ScriptedAdapter();
		const onExit = vi.fn();
		const view = await mount(adapter, onExit);

		adapter.endLatest(null);
		expect(onExit).toHaveBeenCalledWith('s1', null);
		await view.reachable(false);
		// Nothing to open while the host is away.
		expect(adapter.opened).toHaveLength(1);
		await view.reachable(true);

		await vi.waitFor(() => expect(adapter.opened).toHaveLength(2));
		expect(adapter.opened[1]).toEqual(adapter.opened[0]);
	});

	it('reopens when the ending arrived after the host was already unreachable', async () => {
		const adapter = new ScriptedAdapter();
		const view = await mount(adapter);

		await view.reachable(false);
		adapter.endLatest(0);
		await view.reachable(true);

		await vi.waitFor(() => expect(adapter.opened).toHaveLength(2));
	});

	it('leaves a terminal that ended on a host that stayed reachable as it ended', async () => {
		const adapter = new ScriptedAdapter();
		const view = await mount(adapter);

		adapter.endLatest(0);
		await view.reachable(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(adapter.opened).toHaveLength(1);
	});

	it('does not reopen a live pane when its host blinks', async () => {
		const adapter = new ScriptedAdapter();
		const view = await mount(adapter);

		await view.reachable(false);
		await view.reachable(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		// The relay reattaches a live pane itself; reopening here would tear it down.
		expect(adapter.opened).toHaveLength(1);
	});

	it('reopens once per return, not once per poll', async () => {
		const adapter = new ScriptedAdapter();
		const view = await mount(adapter);

		adapter.endLatest(0);
		await view.reachable(false);
		await view.reachable(true);
		await vi.waitFor(() => expect(adapter.opened).toHaveLength(2));
		await view.reachable(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(adapter.opened).toHaveLength(2);
	});
});
