<script lang="ts">
	/**
	 * A full shell built from the package's own components, for the browser geometry
	 * spec. It exists because jsdom has no layout: the checks that matter here (is the
	 * list a scroll container, is the detail inside the viewport) can only be answered
	 * by a real engine.
	 */
	import {
		type GridHost,
		type TerminalLayout,
		agentRows,
		buildDefaultSlots,
		cardPrefs,
		defaultLayout,
		historySeries,
		serviceOptions,
		setSidebarWidth,
		toggleZoom,
		uncommittedSummary,
	} from '@pdmux/core';
	import { EchoTerminalAdapter } from '../../src/adapters/terminal-adapter.js';
	import CommitDetail from '../../src/components/CommitDetail.svelte';
	import GitGraph from '../../src/components/GitGraph.svelte';
	import HostSidebar from '../../src/components/HostSidebar.svelte';
	import SplitHandle from '../../src/components/SplitHandle.svelte';
	import TerminalGrid from '../../src/components/TerminalGrid.svelte';

	const NOW = Date.now();
	const hosts: GridHost[] = [
		{ id: 'h1', name: 'alpha', online: true, sessions: [{ name: 'main', attached: 1, windows: 2 }] },
		// A real EC2 private-DNS name: long, and ONE unbreakable token. This is the shape that
		// overflowed the card header when the title had no truncation rule — a wrapping
		// multi-word label only grew the card, this one pushed the ⚙ off the edge.
		{
			id: 'h2',
			name: 'ip-10-0-12-233.ap-northeast-2.compute.internal',
			online: true,
			sessions: [{ name: 'main', attached: 0, windows: 1 }],
		},
	];

	let layout = $state<TerminalLayout>({ ...defaultLayout(), slots: buildDefaultSlots(hosts, { pad: 2 }) });
	const adapter = new EchoTerminalAdapter();

	const seconds = Math.floor(NOW / 1000);
	const history = historySeries(
		{
			t: Array.from({ length: 40 }, (_, i) => seconds - (39 - i) * 30),
			hosts: [
				{
					id: 'h1',
					cpu: Array.from({ length: 40 }, (_, i) => (i * 7) % 100),
					// Swap carries history too, so the fourth row draws a real sparkline and
					// the label-column probe measures a row in its full shape rather than one
					// whose right-hand side happens to be empty.
					swap: Array.from({ length: 40 }, (_, i) => (i * 3) % 100),
				},
			],
		},
		'h1',
	);

	// Folding is measured by DOING it, not by rendering a fixture that is already
	// folded: the regression the geometry guards is the header changing shape as the
	// chevron turns, and only a real toggle puts both states on the same card.
	let folded = $state<Record<string, boolean>>({});

	const cards = $derived(
		hosts.map((host) => ({
		host: {
			id: host.id,
			name: host.name,
			state: 'online' as const,
			// ⚠ ON THE LONG-NAME CARD DELIBERATELY. That name is one unbreakable token and
			// is the shape that pushed the ⚙ off the edge before the header had a
			// truncation rule; putting the update row on the same card is what makes the
			// existing overflow probes cover the new widget for free.
			update:
				host.id === 'h2'
					? { kind: 'offer' as const, label: 'Update available — 0.1.7' }
					: null,
		},
		agents: agentRows(
			[{ provider: 'claude', processes: 2, ts: seconds, windows: [{ key: 'session', remainingPct: 82 }] }],
			['claude', 'codex'],
			NOW,
		),
		// SWAP is the widest of the four labels (a capital W against DISK's I), so it
		// is what the label-column probe is really measuring.
		//
		// The two cards carry the two swap states on purpose: one host under real
		// pressure (past SWAP_HOT_PCT, so the row is red) and one with swap turned off,
		// which reports a measured 0/0 rather than a dash. The swapless one is the
		// shape most of a real fleet has and the one easiest to regress into a dash.
		resources:
			host.id === 'h2'
				? { cpuPct: 34, memPct: 52, diskPct: 66, swapPct: 0, swapHint: '0B/0B' }
				: { cpuPct: 91, memPct: 47, diskPct: 66, swapPct: 62, swapHint: '5.0Gi/8.0Gi' },
		history,
		services: serviceOptions([{ id: 'web', label: 'web', url: 'https://web.test', status: 'up' as const }]),
		prefs: cardPrefs({}, host.id),
		collapsed: folded[host.id] === true,
		})),
	);

	// Enough rows that the list must scroll — the whole point of the check.
	const commits = Array.from({ length: 80 }, (_, i) => ({
		sha: `${String(i).padStart(4, '0')}`.padEnd(40, 'a'),
		parents: i === 79 ? [] : [`${String(i + 1).padStart(4, '0')}`.padEnd(40, 'a')],
		subject: `commit number ${i} with a subject long enough to need ellipsis in a narrow dock`,
		author: 'tester',
		date: seconds - i * 3600,
		refs: i === 0 ? ['HEAD -> main'] : [],
	}));

	let selected = $state<string | null>(null);
	const selectedCommit = $derived(commits.find((c) => c.sha === selected) ?? null);
	const detail = $derived(
		selectedCommit
			? {
					body: 'body line\n'.repeat(20),
					// ⚠ THE PATCH HAS TO BE LONGER THAN THE CAP ON ITS OWN. It used to be three
					// lines, and `[TC-PDUI-042]` still passed — because the panel stacked the
					// message, the file list and the diff together, so what overflowed was the
					// STACK, not the patch. Once the faces were split the guard failed at
					// exactly the cap, which is the assertion doing its job.
					files: [
						{
							path: 'src/a.ts',
							status: 'M' as const,
							add: 3,
							del: 1,
							lines: ['@@ -1 +1 @@', ...Array.from({ length: 60 }, (_, i) => `+line ${i}`)],
						},
					],
				}
			: null,
	);

	/**
	 * ⚠ THE FACES ARE SEPARATE SCREENS, CHOSEN BY THE QUERY STRING. Mounting the
	 * `File tree` face beside the main harness broke two specs that had nothing to do
	 * with it — the page grew past the viewport, and `[data-pdmux-detail]` matched
	 * twice. A harness that changes what the other specs measure is not a harness.
	 */
	const screen = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('screen');
</script>

{#if screen === 'tree'}
<!--
	The `File tree` face, mounted on its own so its geometry can be measured.

	⚠ THE LINE IS DELIBERATELY LONGER THAN ANY COLUMN THIS EVER GETS. Whether a file
	viewer scrolls sideways cannot be asserted on content that fits.
-->
	<div class="pdmux pdmux-graph" data-harness="tree" style="width:900px;height:320px">
	<CommitDetail
		commit={{ sha: 'abc1234567890', subject: 'a commit', author: 'tester', date: 1_784_000_000 }}
		detail={{ body: '', files: [] }}
		view="tree"
		treeEntries={[{ path: 'src/a.ts', size: 12 }]}
		treePath="src/a.ts"
		blob={{
			path: 'src/a.ts',
			lines: [
				'const wide = ' + "'x'".repeat(120) + ';',
				'const narrow = 1;',
			],
		}}
	/>
</div>
{:else}
	<div
		class="pdmux pdmux-shell"
		data-sidebar={layout.sidebarOpen ? 'open' : 'hidden'}
		data-dock="open"
		style="--pdmux-left:{layout.sidebarWidth}px;--pdmux-right:{layout.dockWidth}px"
	>
		<!-- `onAddHost` is supplied so the column carries its trailing tile here too: it is the
		     last thing in the scroll content, and the geometry checks measure that content. -->
		<HostSidebar
			{cards}
			now={seconds}
			onAddHost={() => {}}
			onUpdateAgent={() => {}}
			onToggleCollapse={(hostId) => (folded = { ...folded, [hostId]: !folded[hostId] })}
		/>
		<SplitHandle onCommit={(delta) => (layout = setSidebarWidth(layout, layout.sidebarWidth + delta))} />
		<div class="pdmux pdmux-panel">
			<TerminalGrid
				{layout}
				{hosts}
				{adapter}
				sweepMs={0}
				onZoom={(slotId) => (layout = toggleZoom(layout, slotId))}
			/>
		</div>
		<SplitHandle invert />
		<div class="pdmux pdmux-graph">
			<GitGraph
				{commits}
				refs={[{ name: 'main', kind: 'local', sha: commits[0]?.sha }]}
				head={commits[0]?.sha}
				uncommitted={uncommittedSummary({ unstaged: 3 })}
				uncommittedLabel="modified 3"
				selectedSha={selected}
				onSelect={(sha) => (selected = sha)}
			/>
			<!-- ⚠ `view="changes"` AND A CHOSEN FILE, ON PURPOSE. The tab chrome lives in
			     `apps/web` now (this package cannot import shadcn — [TC-PDUI-030]), so both
			     the face and the open file are props, and neither default puts a patch on
			     screen. `[TC-PDUI-042]` exists to prove a patch longer than the cap SCROLLS
			     inside the panel, and it caught this itself: without them its own guard
			     failed with "the harness patch must exceed the cap, or this proves
			     nothing". -->
			<CommitDetail commit={selectedCommit} {detail} view="changes" selectedPath="src/a.ts" />
		</div>
	</div>
{/if}
