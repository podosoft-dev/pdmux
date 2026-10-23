<script lang="ts">
	import { defaultLayout } from '@pdmux/core';
	import type { TerminalAdapter } from '../src/adapters/terminal-adapter.js';
	import type { TerminalSurfaceFactory } from '../src/adapters/terminal-surface.js';
	import TerminalGrid from '../src/components/TerminalGrid.svelte';
	let { adapter, createSurface, onZoom }: { adapter: TerminalAdapter; createSurface: TerminalSurfaceFactory; onZoom: (id: string) => void } = $props();
</script>

{#snippet warning()}<button type="button" data-warning-help>Temporary terminal explanation</button>{/snippet}
<TerminalGrid
	layout={{ ...defaultLayout(), mode: 'split2', slots: [
		{ id: 'temporary', hostId: 'h1', kind: 'shell', session: null },
		{ id: 'persistent', hostId: 'h1', kind: 'attach', backend: 'native', session: 'main', sessionId: 'persistent-session' },
	] }}
	hosts={[{ id: 'h1', name: 'fixture', online: true, sessions: [] }]}
	{adapter}
	{createSurface}
	{onZoom}
	paneWarning={warning}
	sweepMs={0}
/>
