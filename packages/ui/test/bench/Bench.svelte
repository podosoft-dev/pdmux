<script lang="ts">
	/**
	 * The terminal grid under a recorded load, with nothing else on the page.
	 *
	 * ⚠ IT DRIVES `TerminalGrid`, NOT A BARE `Terminal`. The question is what a person
	 * experiences in the product, and the product wraps every pane in a component that
	 * re-reads state as output arrives (`TerminalPane` asks `canScroll()` on every
	 * chunk). A benchmark against a raw xterm would measure a terminal nobody uses.
	 *
	 * Everything varies by query string so one spec can walk the grid: `?panes=9&renderer=webgl&rate=2`.
	 */
	import { type GridHost, type TerminalLayout, defaultLayout } from '@pdmux/core';
	import TerminalGrid from '../../src/components/TerminalGrid.svelte';
	import { type BenchRenderer, benchChannel, createBenchSurface } from './bench-surface.js';
	import { type TraceChunk, TraceReplayAdapter } from './load-adapter.js';

	const params = new URLSearchParams(window.location.search);
	const panes = Number(params.get('panes') ?? '1');
	const renderer = (params.get('renderer') ?? 'dom') as BenchRenderer;
	const rate = Number(params.get('rate') ?? '1');

	const hosts: GridHost[] = [{ id: 'h1', name: 'bench', online: true, sessions: [{ name: 'main', attached: 1, windows: 1 }] }];
	// `tab` shows one pane, and the two splits show four and nine — the shapes a person
	// actually arranges, rather than an arbitrary count.
	const mode = panes >= 9 ? 'split9' : panes >= 4 ? 'split4' : 'tab';

	let trace = $state<TraceChunk[] | null>(null);
	let adapter = $state<TraceReplayAdapter | null>(null);
	let layout = $state<TerminalLayout>({ ...defaultLayout(), mode, slots: [] });

	const channel = benchChannel();
	const createSurface = createBenchSurface(renderer);

	// Loaded rather than imported: the fixture is a recording, and a 70 KiB module in
	// the source tree is a recording pretending to be code.
	$effect(() => {
		void (async () => {
			const response = await fetch('./trace.jsonl');
			const chunks = (await response.text())
				.split('\n')
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as TraceChunk);
			trace = chunks;
			adapter = new TraceReplayAdapter({ trace: chunks, rate });
			layout = {
				...layout,
				slots: Array.from({ length: panes }, (_, i) => ({
					id: `s${i + 1}`,
					hostId: 'h1',
					kind: 'attach' as const,
					session: 'main',
				})),
			};
			// The spec waits on this rather than on a timeout: a fixed sleep is how a
			// benchmark ends up measuring a page that had not finished mounting.
			(window as unknown as { __pdmuxBenchReady?: boolean }).__pdmuxBenchReady = true;
		})();
	});
</script>

<!--
  ⚠ NO `.pdmux-shell` HERE. The shell places its children by role attribute and is
  mobile-first, so a lone panel dropped into it lands in a 24px column — measured, and
  it made the first run benchmark a terminal two characters wide. The bench wants the
  grid at full size and nothing else on the page, so it gives it the viewport directly.
-->
<div class="pdmux" style="position:fixed;inset:0;display:flex">
	{#if adapter && trace}
		<TerminalGrid {layout} {hosts} {adapter} {createSurface} sweepMs={0} onZoom={() => {}} />
	{/if}
</div>

<!-- Visible so a human running the harness by hand sees what the spec is reading. -->
<div style="position:fixed;bottom:0;right:0;padding:2px 6px;font:11px monospace;background:#000;color:#0f0;z-index:99">
	{renderer}{channel.rendererActive ? '' : ' (dom fallback)'} · {panes}p · {rate}x
</div>
