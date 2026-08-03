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
			hosts: [{ id: 'h1', cpu: Array.from({ length: 40 }, (_, i) => (i * 7) % 100) }],
		},
		'h1',
	);

	const cards = hosts.map((host) => ({
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
		resources: { cpuPct: 91, memPct: 47, diskPct: 66 },
		history,
		services: serviceOptions([{ id: 'web', label: 'web', url: 'https://web.test', status: 'up' as const }]),
		prefs: cardPrefs({}, host.id),
	}));

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
					files: [{ path: 'src/a.ts', status: 'M' as const, add: 3, del: 1, lines: ['@@ -1 +1 @@', '-old', '+new'] }],
				}
			: null,
	);
</script>

<div
	class="pdmux pdmux-shell"
	data-sidebar={layout.sidebarOpen ? 'open' : 'hidden'}
	data-dock="open"
	style="--pdmux-left:{layout.sidebarWidth}px;--pdmux-right:{layout.dockWidth}px"
>
	<!-- `onAddHost` is supplied so the column carries its trailing tile here too: it is the
	     last thing in the scroll content, and the geometry checks measure that content. -->
	<HostSidebar {cards} now={seconds} onAddHost={() => {}} onUpdateAgent={() => {}} />
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
		<CommitDetail commit={selectedCommit} {detail} />
	</div>
</div>
