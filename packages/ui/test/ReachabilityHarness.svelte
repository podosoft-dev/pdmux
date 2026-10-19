<script lang="ts">
	/**
	 * Owns the host's reachability the way the app's feed does — one signal — so a test
	 * can flip it without the test renderer replacing every other prop at the same time.
	 */
	import type { GridHost, TerminalLayout } from '@pdmux/core';
	import type { TerminalAdapter } from '../src/adapters/terminal-adapter.js';
	import type { TerminalSurfaceFactory } from '../src/adapters/terminal-surface.js';
	import TerminalGrid from '../src/components/TerminalGrid.svelte';
	import { untrack } from 'svelte';

	let {
		layout,
		adapter,
		createSurface,
		onExit,
		control,
	}: {
		layout: TerminalLayout;
		adapter: TerminalAdapter;
		createSurface: TerminalSurfaceFactory;
		onExit?: (slotId: string, code: number | null) => void;
		control: { setOnline?: (online: boolean) => void };
	} = $props();

	let online = $state(true);
	// Handed out once: the test holds the setter, the harness holds the signal.
	untrack(() => control).setOnline = (next: boolean): void => {
		online = next;
	};
	const hosts = $derived<GridHost[]>([{ id: 'h1', name: 'alpha', online, sessions: [] }]);
</script>

<TerminalGrid {layout} {hosts} {adapter} {createSurface} sweepMs={0} {onExit} />
