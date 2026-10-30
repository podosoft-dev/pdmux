/**
 * A pane on a host whose agent is replacing itself says so over the whole pane.
 *
 * Automatic agent updates restart the agent on their own schedule, so a terminal drops and comes
 * back without anybody having pressed anything. These lock the package's half: the cover, its
 * wording for a session and for a plain shell, and which overlay wins.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { type TerminalLayout, defaultLayout } from '@pdmux/core';
import type { TerminalAdapter, TerminalConnection } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import korean from '../../../apps/web/src/lib/i18n/catalogs/app/ko.json';
import TerminalGrid from '../src/components/TerminalGrid.svelte';
import TerminalPane from '../src/components/TerminalPane.svelte';

afterEach(cleanup);

const surface: TerminalSurface = {
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

const adapter: TerminalAdapter = {
	open: (): TerminalConnection => ({
		send: () => undefined,
		resize: () => undefined,
		onData: () => () => undefined,
		onExit: () => () => undefined,
		close: () => undefined,
	}),
};

const pane = korean.pdmux.pane;
const KOREAN: Record<string, string> = {
	'pdmux.pane.agentUpdating': pane.agentUpdating,
	'pdmux.pane.agentUpdatingAny': pane.agentUpdatingAny,
	'pdmux.pane.agentUpdatingSession': pane.agentUpdatingSession,
	'pdmux.pane.agentUpdatingShell': pane.agentUpdatingShell,
	'pdmux.pane.connectionLost': pane.connectionLost,
};
const t = (key: string, fallback: string): string => KOREAN[key] ?? fallback;
const SESSION = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
const UPDATE = { phase: 'restarting', targetVersion: '0.1.39' };

async function mounted(props: Record<string, unknown>) {
	const view = render(TerminalPane, {
		props: { slot: SESSION, index: 0, hostName: 'alpha', adapter, createSurface: () => surface, t, ...props },
	});
	await tick();
	return view;
}

describe('[TC-PDUI-254] a pane says its agent is updating', () => {
	it('covers a session pane with the target version and the promise that it reconnects', async () => {
		const view = await mounted({ agentUpdate: UPDATE });
		const cover = view.container.querySelector('[data-pdmux-agent-update]') as HTMLElement | null;
		expect(cover?.getAttribute('data-pdmux-agent-update')).toBe('restarting');
		expect(cover?.getAttribute('role')).toBe('status');
		expect(cover?.textContent).toContain(pane.agentUpdating.replace('{version}', '0.1.39'));
		expect(cover?.textContent).toContain(pane.agentUpdatingSession);
		expect(view.container.querySelector('[data-pdmux-pane]')?.classList.contains('pdmux-updating')).toBe(true);
	});

	it('tells a plain shell that it closes, and words an update without a version', async () => {
		const view = await mounted({ slot: { id: 's2', hostId: 'h1', kind: 'shell' as const }, agentUpdate: { phase: 'accepted', targetVersion: null } });
		const cover = view.container.querySelector('[data-pdmux-agent-update]') as HTMLElement | null;
		expect(cover?.textContent).toContain(pane.agentUpdatingAny);
		expect(cover?.textContent).toContain(pane.agentUpdatingShell);
	});

	it('wins over the unreachable veil while the agent restarts, and loses to a lost server', async () => {
		const offline = await mounted({ agentUpdate: UPDATE, reachable: false });
		expect(offline.container.querySelector('[data-pdmux-agent-update]')).not.toBeNull();
		expect(offline.container.querySelector('[data-pdmux-pane]')?.classList.contains('pdmux-unreachable')).toBe(false);
		offline.unmount();

		const lost = await mounted({ agentUpdate: UPDATE, connectionLost: true });
		expect(lost.container.querySelector('[data-pdmux-agent-update]')).toBeNull();
		expect(lost.container.querySelector('[data-pdmux-lost]')).not.toBeNull();
	});

	it('draws nothing without an update', async () => {
		const view = await mounted({});
		expect(view.container.querySelector('[data-pdmux-agent-update]')).toBeNull();
	});

	it('covers exactly the panes on the updating host in a grid', async () => {
		const layout: TerminalLayout = {
			...defaultLayout(),
			mode: 'split2',
			slots: [SESSION, { id: 's2', hostId: 'h2', kind: 'attach', session: 'main' }],
		};
		const hosts = [
			{ id: 'h1', name: 'alpha', online: true, agentUpdate: UPDATE },
			{ id: 'h2', name: 'beta', online: true, agentUpdate: null },
		];
		const view = render(TerminalGrid, { props: { layout, hosts, adapter, createSurface: () => surface, t } });
		await tick();
		const covered = [...view.container.querySelectorAll('[data-pdmux-pane]')].filter((p) => p.querySelector('[data-pdmux-agent-update]'));
		expect(covered.map((p) => p.getAttribute('data-pdmux-pane'))).toEqual(['s1']);
	});
});
