/**
 * A screen cut off from its server says so — in the column of hosts and in every pane.
 *
 * During a three-minute reverse-proxy outage the cards stayed green and every pane kept its last
 * frame while keystrokes went nowhere. These lock the package's half: the notice, the cover, and
 * the refusal of input. Whether the server is reachable is the app's to say.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { type TerminalLayout, defaultLayout, slotIdentityLabel, slotLabel } from '@pdmux/core';
import type { TerminalAdapter, TerminalConnection, TerminalOpenTarget } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import korean from '../../../apps/web/src/lib/i18n/catalogs/app/ko.json';
import HostSidebar from '../src/components/HostSidebar.svelte';
import TerminalGrid from '../src/components/TerminalGrid.svelte';
import TerminalPane from '../src/components/TerminalPane.svelte';

afterEach(cleanup);

/** A surface whose typing the test drives. */
function surface(): { factory: () => TerminalSurface; type: (data: string) => void } {
	const listeners = new Set<(data: string, source?: 'wheel') => void>();
	const value: TerminalSurface = {
		write: () => undefined,
		fit: () => ({ cols: 80, rows: 24 }),
		focus: () => undefined,
		scrollPages: () => undefined,
		canScroll: () => false,
		readHistory: () => ({ lines: [], scrollback: false }),
		onScrollbackRequest: () => () => undefined,
		onGesture: () => () => undefined,
		onData: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => undefined,
	};
	return { factory: () => value, type: (data) => { for (const listener of listeners) listener(data); } };
}

/** An adapter that records what each pane sends. */
class RecordingAdapter implements TerminalAdapter {
	readonly sent: string[] = [];
	readonly opened: TerminalOpenTarget[] = [];
	open(target: TerminalOpenTarget): TerminalConnection {
		this.opened.push(target);
		return {
			send: (data: string) => this.sent.push(data),
			resize: () => undefined,
			onData: () => () => undefined,
			onExit: () => () => undefined,
			close: () => undefined,
		};
	}
}

const SLOT = { id: 's1', hostId: 'h1', kind: 'attach' as const, session: 'main' };
/** The app's Korean wording, read from its catalogue rather than copied into this file. */
const KOREAN: Record<string, string> = {
	'pdmux.pane.connectionLost': korean.pdmux.pane.connectionLost,
	'pdmux.sidebar.connectionLost': korean.pdmux.sidebar.connectionLost,
	'pdmux.pane.shell': korean.pdmux.pane.shell,
};
const SHELL = korean.pdmux.pane.shell;
const t = (key: string, fallback: string): string => KOREAN[key] ?? fallback;

async function mounted(props: Record<string, unknown>) {
	const typing = surface();
	const adapter = new RecordingAdapter();
	const view = render(TerminalPane, {
		props: { slot: SLOT, index: 0, hostName: 'alpha', adapter, createSurface: typing.factory, focused: true, t, ...props },
	});
	await vi_waitForOpen(adapter);
	return { view, typing, adapter };
}

async function vi_waitForOpen(adapter: RecordingAdapter): Promise<void> {
	for (let attempt = 0; attempt < 50 && adapter.opened.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
	await tick();
}

describe('[TC-PDUI-238] a pane cut off from the server is covered, not left looking alive', () => {
	it('dims the pane behind one centred line and drops the small reconnecting note', async () => {
		const { view } = await mounted({ connectionLost: true, transport: 'reconnecting' });
		const pane = view.container.querySelector('[data-pdmux-pane]') as HTMLElement;
		const cover = view.container.querySelector('[data-pdmux-lost]') as HTMLElement | null;
		expect(pane.classList.contains('pdmux-cut-off')).toBe(true);
		expect(cover?.textContent?.trim()).toBe(KOREAN['pdmux.pane.connectionLost']);
		expect(cover?.getAttribute('role')).toBe('status');
		expect(view.container.querySelector('[data-pdmux-transport]')).toBeNull();
	});

	it('covers an unreachable pane too — with the server away nobody knows the host is gone', async () => {
		const { view } = await mounted({ connectionLost: true, reachable: false });
		expect(view.container.querySelector('[data-pdmux-lost]')).not.toBeNull();
		expect(view.container.querySelector('[data-pdmux-pane]')?.classList.contains('pdmux-unreachable')).toBe(false);
	});

	it('draws nothing while connected', async () => {
		const { view } = await mounted({ connectionLost: false });
		expect(view.container.querySelector('[data-pdmux-lost]')).toBeNull();
		expect(view.container.querySelector('[data-pdmux-pane]')?.classList.contains('pdmux-cut-off')).toBe(false);
	});
});

describe('[TC-PDUI-239] a keystroke into a cut-off pane is refused visibly', () => {
	it('sends nothing while cut off, marks the refusal, and sends again once reconnected', async () => {
		const { view, typing, adapter } = await mounted({ connectionLost: true });
		typing.type('ls\r');
		await tick();
		expect(adapter.sent).toEqual([]);
		expect(view.container.querySelector('[data-pdmux-refused]')?.getAttribute('data-pdmux-refused')).toBe('true');

		await view.rerender({ connectionLost: false });
		typing.type('ls\r');
		expect(adapter.sent).toEqual(['ls\r']);

		// A later loss starts unmarked: the pulse is for keys pressed during THIS loss.
		await view.rerender({ connectionLost: true });
		expect(view.container.querySelector('[data-pdmux-refused]')?.getAttribute('data-pdmux-refused')).toBe('false');
	});
});

describe('[TC-PDUI-240] the grid covers exactly the panes the app names', () => {
	it('uses the per-host answer when there is one and the grid-wide flag otherwise', async () => {
		const layout: TerminalLayout = {
			...defaultLayout(),
			mode: 'split2',
			slots: [SLOT, { id: 's2', hostId: 'h2', kind: 'attach', session: 'main' }],
		};
		const hosts = [{ id: 'h1', name: 'alpha', online: true }, { id: 'h2', name: 'beta', online: true }];
		const base = { layout, hosts, adapter: new RecordingAdapter(), createSurface: surface().factory, t };
		const perHost = render(TerminalGrid, { props: { ...base, connectionLostFor: (hostId: string) => hostId === 'h2' } });
		await tick();
		const covered = [...perHost.container.querySelectorAll('[data-pdmux-pane]')].filter((pane) => pane.querySelector('[data-pdmux-lost]'));
		expect(covered.map((pane) => pane.getAttribute('data-pdmux-pane'))).toEqual(['s2']);
		perHost.unmount();

		const all = render(TerminalGrid, { props: { ...base, connectionLost: true } });
		await tick();
		expect(all.container.querySelectorAll('[data-pdmux-lost]')).toHaveLength(2);
	});
});

describe('[TC-PDUI-241] the host column says the server is gone, above the first card', () => {
	it('shows the notice and marks the column for anything but online', () => {
		const cards = [{ host: { id: 'h1', name: 'alpha', state: 'unknown' as const } }];
		const online = render(HostSidebar, { props: { cards, t } });
		expect(online.container.querySelector('[data-pdmux-sidebar-notice]')).toBeNull();
		expect(online.container.querySelector('[data-pdmux-sidebar]')?.getAttribute('data-pdmux-connection')).toBe('online');
		online.unmount();

		for (const connection of ['reconnecting', 'offline'] as const) {
			const lost = render(HostSidebar, { props: { cards, t, connection } });
			const column = lost.container.querySelector('[data-pdmux-sidebar]') as HTMLElement;
			const notice = column.querySelector('[data-pdmux-sidebar-notice]') as HTMLElement | null;
			expect(notice?.textContent?.trim()).toBe(KOREAN['pdmux.sidebar.connectionLost']);
			expect(column.getAttribute('data-pdmux-connection')).toBe(connection);
			// Before every card in document order.
			const card = column.querySelector('[data-pdmux-host]') as HTMLElement;
			expect(notice!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			lost.unmount();
		}
	});
});

describe('[TC-PDUI-242] a temporary shell is named in the reader’s language', () => {
	it('labels the pane with the translated word and keeps English for a consumer without i18n', async () => {
		const shell = { id: 's1', hostId: 'h1', kind: 'shell' as const, session: null };
		expect(slotIdentityLabel(shell, 'alpha')).toBe('alpha·shell');
		expect(slotLabel(shell, 'alpha', SHELL)).toBe(`alpha·${SHELL}`);
		expect(slotLabel({ ...SLOT }, 'alpha', SHELL)).toBe('alpha·main');

		const typing = surface();
		const view = render(TerminalPane, {
			props: { slot: shell, index: 0, hostName: 'alpha', adapter: new RecordingAdapter(), createSurface: typing.factory, t },
		});
		await tick();
		expect(view.container.querySelector('.pdmux-pane-head')?.getAttribute('aria-label')).toBe(`alpha·${SHELL}`);
	});
});
