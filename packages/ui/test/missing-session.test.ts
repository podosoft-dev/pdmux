/**
 * A native pane whose session the host no longer has.
 *
 * After a host restart under an agent that kept no restore record, a saved native pane gets
 * `SESSION_NOT_FOUND`. The pane says the session and its programs are gone and offers ONE
 * thing: a new session under the same name, opened when the person clicks — never by itself.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { type TerminalLayout, type TerminalSlot, defaultLayout } from '@pdmux/core';
import type { TerminalConnection, TerminalOpenTarget } from '../src/adapters/terminal-adapter.js';
import type { TerminalSurface } from '../src/adapters/terminal-surface.js';
import english from '../../../apps/web/src/lib/i18n/catalogs/app/en.json';
import korean from '../../../apps/web/src/lib/i18n/catalogs/app/ko.json';
import TerminalGrid from '../src/components/TerminalGrid.svelte';
import TerminalPane from '../src/components/TerminalPane.svelte';

afterEach(cleanup);

const GONE = 'd5ac0000-0000-4000-8000-000000000001';
const FRESH = 'd5ac0000-0000-4000-8000-000000000002';
/** The production slot this was reported on. */
const NATIVE: TerminalSlot = { id: 's14', hostId: 'h1', kind: 'attach', backend: 'native', session: 'w2', sessionId: GONE, intent: 'attach', tags: [{ name: 'prod', color: '#123456' }] };

function surface(): () => TerminalSurface {
	const value: TerminalSurface = {
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
	return () => value;
}

/** An adapter whose host the test speaks for: `missing(n)` / `ready(n, id)` answer the n-th open. */
function host(): {
	adapter: { open: (target: TerminalOpenTarget) => TerminalConnection };
	targets: TerminalOpenTarget[];
	missing: (n: number) => void;
	ready: (n: number, id: string) => void;
} {
	const targets: TerminalOpenTarget[] = [];
	const opened: Array<{ missing: Set<() => void>; session: Set<(id: string) => void>; exit: Set<(code: number | null) => void> }> = [];
	return {
		targets,
		adapter: {
			open: (target) => {
				targets.push(target);
				const entry = { missing: new Set<() => void>(), session: new Set<(id: string) => void>(), exit: new Set<(code: number | null) => void>() };
				opened.push(entry);
				return {
					send: () => undefined,
					resize: () => undefined,
					onData: () => () => undefined,
					onExit: (listener) => { entry.exit.add(listener); return () => entry.exit.delete(listener); },
					onMissing: (listener) => { entry.missing.add(listener); return () => entry.missing.delete(listener); },
					onSession: (listener) => { entry.session.add(listener); return () => entry.session.delete(listener); },
					close: () => undefined,
				};
			},
		},
		missing: (n) => {
			const entry = opened[n]!;
			for (const listener of entry.missing) listener();
			for (const listener of entry.exit) listener(null);
		},
		ready: (n, id) => { for (const listener of opened[n]!.session) listener(id); },
	};
}

/** The app's translator over one catalogue (`uiTranslate` in apps/web). */
function translate(catalog: unknown): (key: string, fallback: string) => string {
	return (key, fallback) => {
		let current: unknown = catalog;
		for (const part of key.split('.')) current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[part] : undefined;
		return typeof current === 'string' ? current : fallback;
	};
}

const settle = async (): Promise<void> => { await tick(); await Promise.resolve(); await tick(); };

it('[TC-PDTERM-175] the button appears only on a native pane the host answered SESSION_NOT_FOUND', async () => {
	const native = host();
	const { container } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface() } });
	await vi.waitFor(() => expect(native.targets).toHaveLength(1));
	// Nothing is claimed before the host says so.
	expect(container.querySelector('[data-pdmux-missing]')).toBeNull();
	native.missing(0);
	await tick();
	const notice = container.querySelector('[data-pdmux-missing]');
	expect(notice?.textContent).toContain("Session 'w2' no longer exists on this host. Programs that were running in it are gone.");
	expect(notice?.querySelector('[data-pdmux-missing-reopen]')?.textContent).toBe('Open a new session with the same name');
	// Above the terminal, never over it.
	expect(notice?.nextElementSibling?.classList.contains('pdmux-pane-body')).toBe(true);
	cleanup();

	// A tmux pane reopens by name on the host already; a shell has no name to reuse.
	for (const slot of [
		{ id: 't1', hostId: 'h1', kind: 'attach', session: 'w2', tmuxId: '$0' },
		{ id: 't2', hostId: 'h1', kind: 'shell', session: null },
	] satisfies TerminalSlot[]) {
		const other = host();
		const view = render(TerminalPane, { props: { slot, index: 0, hostName: 'alpha', adapter: other.adapter, createSurface: surface() } });
		await vi.waitFor(() => expect(other.targets).toHaveLength(1));
		other.missing(0);
		await tick();
		expect(view.container.querySelector('[data-pdmux-missing]')).toBeNull();
		expect(view.container.querySelector('[data-pdmux-missing-reopen]')).toBeNull();
		cleanup();
	}
});

it('[TC-PDTERM-176] nothing reopens until the click, and the click opens the name without the vanished UUID', async () => {
	const native = host();
	const { container } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface() } });
	await vi.waitFor(() => expect(native.targets).toHaveLength(1));
	native.missing(0);
	await settle();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await settle();
	expect(native.targets).toHaveLength(1);
	(container.querySelector('[data-pdmux-missing-reopen]') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(native.targets).toHaveLength(2));
	expect(native.targets[1]).toEqual({ slotId: 's14', hostId: 'h1', kind: 'session', session: 'w2', backend: 'native', intent: 'ensure', cols: 80, rows: 24 });
	expect(native.targets[1]).not.toHaveProperty('sessionId');
	// The notice goes with the old connection.
	expect(container.querySelector('[data-pdmux-missing]')).toBeNull();
});

it('[TC-PDTERM-177] the new UUID is reported for the same slot, and a later reopen targets it', async () => {
	const native = host();
	const resolved: Array<[string, string]> = [];
	const { container, rerender } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface(), onSessionResolved: (slotId: string, id: string) => resolved.push([slotId, id]) } });
	await vi.waitFor(() => expect(native.targets).toHaveLength(1));
	native.missing(0);
	await tick();
	(container.querySelector('[data-pdmux-missing-reopen]') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(native.targets).toHaveLength(2));
	native.ready(1, FRESH);
	expect(resolved).toEqual([['s14', FRESH]]);
	// The host goes away and comes back: the pane reopens the NEW session, not the vanished one.
	native.missing(1);
	await rerender({ reachable: false });
	await rerender({ reachable: true });
	await vi.waitFor(() => expect(native.targets).toHaveLength(3));
	expect(native.targets[2]).toMatchObject({ slotId: 's14', session: 'w2', backend: 'native', sessionId: FRESH, intent: 'attach' });
});

it('[TC-PDUI-244] the reconnecting line is not drawn under a missing session', async () => {
	const native = host();
	const { container } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface(), transport: 'idle' } });
	await vi.waitFor(() => expect(native.targets).toHaveLength(1));
	// Control: an idle socket on a live pane says it is reconnecting.
	expect(container.querySelector('[data-pdmux-transport]')).not.toBeNull();
	native.missing(0);
	await tick();
	expect(container.querySelector('[data-pdmux-missing]')).not.toBeNull();
	expect(container.querySelector('[data-pdmux-transport]')).toBeNull();
});

it('[TC-PDUI-245] the notice and the button speak the reader’s language', async () => {
	for (const [catalog, sentence, button] of [
		[korean, "'w2' 세션이 이 호스트에 더 이상 없습니다. 그 안에서 실행 중이던 프로그램은 사라졌습니다.", '같은 이름으로 새 세션 열기'],
		[english, "Session 'w2' no longer exists on this host. Programs that were running in it are gone.", 'Open a new session with the same name'],
	] as const) {
		const native = host();
		const { container } = render(TerminalPane, { props: { slot: NATIVE, index: 0, hostName: 'alpha', adapter: native.adapter, createSurface: surface(), t: translate(catalog) } });
		await vi.waitFor(() => expect(native.targets).toHaveLength(1));
		native.missing(0);
		await tick();
		expect(container.querySelector('[data-pdmux-missing] > span')?.textContent).toBe(sentence);
		expect(container.querySelector('[data-pdmux-missing-reopen]')?.textContent).toBe(button);
		cleanup();
	}
});

it('[TC-PDUI-246] in the grid the slot keeps its id and the app is told the new UUID to save', async () => {
	const native = host();
	const resolved: Array<[string, string]> = [];
	const layout: TerminalLayout = { ...defaultLayout(), mode: 'split4', slots: [null, NATIVE] };
	const { container } = render(TerminalGrid, { props: {
		layout, hosts: [{ id: 'h1', name: 'alpha', online: true }], adapter: native.adapter, createSurface: surface(), sweepMs: 0,
		onSessionResolved: (slotId: string, id: string) => resolved.push([slotId, id]),
	} });
	await vi.waitFor(() => expect(native.targets).toHaveLength(1));
	native.missing(0);
	await tick();
	const pane = container.querySelector('[data-pdmux-pane="s14"]')!;
	expect(pane.getAttribute('data-pdmux-cell')).toBe('1');
	(pane.querySelector('[data-pdmux-missing-reopen]') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(native.targets).toHaveLength(2));
	expect(native.targets[1]).toMatchObject({ slotId: 's14', session: 'w2', intent: 'ensure' });
	native.ready(1, FRESH);
	expect(resolved).toEqual([['s14', FRESH]]);
	// The pane is still the one in cell 1 — nothing was remounted elsewhere.
	expect(container.querySelector('[data-pdmux-pane="s14"]')).toBe(pane);
});
