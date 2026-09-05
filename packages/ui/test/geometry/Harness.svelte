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
		focusSlot,
		historySeries,
		serviceOptions,
		setSidebarWidth,
		toggleZoom,
		uncommittedSummary,
	} from '@pdmux/core';
	import {
		defaultFsColumns,
		nextFsSort,
		sortFsEntries,
		type FsColumnKey,
		type FsColumns,
		type FsSort,
		setFsColumnWidth,
	} from '@pdmux/core';
	import { EchoTerminalAdapter } from '../../src/adapters/terminal-adapter.js';
	import CommitDetail from '../../src/components/CommitDetail.svelte';
	import FileExplorer from '../../src/components/FileExplorer.svelte';
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

	const query = new URLSearchParams(globalThis.location?.search ?? '');
	const split = query.get('split');
	const mode = split === 'split2' || split === 'split4' || split === 'split9' ? split : defaultLayout().mode;
	let layout = $state<TerminalLayout>({ ...defaultLayout(), mode, slots: buildDefaultSlots(hosts, { pad: 2 }) });
	/**
	 * ⚠ THE SHEET'S NOTES ONLY EXIST ON AN ALTERNATE-BUFFER PANE, so `?history=` puts the
	 * terminal there the way the real thing does: `ESC[?1049h` is the switch a multiplexer sends
	 * on attach, and it is what makes xterm report `scrollback: false` and the pane go and ask
	 * the host. Without it `openHistory` never makes the round trip at all (measured: the sheet
	 * showed 51px of local echo and no note), so the states below would be unreachable.
	 *
	 * Left out of the default page on purpose — every other check here measures the ordinary
	 * pane, and switching buffers for all of them would change what they are measuring.
	 */
	const altScreen = new URLSearchParams(globalThis.location?.search ?? '').has('history');
	const adapter = new EchoTerminalAdapter(
		altScreen
			? {
					// A screenful, so the sheet has a body worth measuring in every state — a one-line
					// pane would make a crushed scroller and a short pane look exactly the same.
					banner: () =>
						'\u001b[?1049h\u001b[H' +
						Array.from({ length: 40 }, (_, i) => `full-screen program row ${i}`).join('\r\n') +
						'\r\n',
				}
			: {},
	);

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

	/**
	 * What the output sheet's remote fetch answers, chosen by the URL.
	 *
	 * ⚠ THE SHEET'S NOTE IS A ROW ABOVE ITS SCROLLER, so each state is a different LAYOUT and
	 * only a browser can say whether the body still fits and still scrolls. That is the class of
	 * bug this harness exists for: a row added above a flex scroller is exactly how the commit
	 * detail once ended up 7,300px below the viewport. `?history=` selects one:
	 *
	 *   full   — a real history came back (no note)
	 *   screen — a full-screen program owns the pane (the multiplexer kept nothing)
	 *   failed — the host could not be asked
	 *   never  — the fetch never settles, so the sheet stays in its pending state
	 */
	const historyState = new URLSearchParams(globalThis.location?.search ?? '').get('history') ?? 'full';
	const historyAnswer = async (): Promise<{ lines: string[]; scrollback: boolean; screenOnly?: boolean } | null> => {
		if (historyState === 'never') return new Promise(() => {});
		if (historyState === 'failed') return null;
		if (historyState === 'screen') return { lines: [], scrollback: false, screenOnly: true };
		return { lines: Array.from({ length: 400 }, (_, i) => `line ${i} of a history long enough to need scrolling`), scrollback: true };
	};

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

	/**
	 * The file explorer face.
	 *
	 * ⚠ IT IS MEASURED AT A CHOSEN WIDTH, BECAUSE THAT IS THE WHOLE RISK. The dock this
	 * panel lives in runs from `DOCK_WIDTH_MIN` (260px) to 900px, and `ui-changes.md`
	 * records what happens when a horizontal row is not measured at its narrow end: a
	 * sibling panel took the commit list from 420px to 0px and every spec stayed green.
	 * `?width=` is how the spec asks for both ends.
	 */
	const filesWidth = Number(
		(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('width')) ?? 420,
	);
	/**
	 * ⚠ THE SCHEME IS A PROP IN THE REAL APP, SO IT IS A QUERY PARAM HERE. The package
	 * cannot read the theme (`FileIcon` explains why), which means a dark page whose
	 * harness forgot to say so shows the LIGHT icons — and a screenshot of it would be
	 * evidence of nothing.
	 */
	const filesScheme =
		(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('scheme')) === 'dark'
			? 'dark'
			: 'light';
	let filesSort = $state<FsSort>({ key: 'name', dir: 'asc' });
	let filesColumns = $state<FsColumns>(defaultFsColumns());
	let columnBase: number | null = null;
	function dragColumn(key: FsColumnKey, delta: number, commit: boolean, panelWidth: number): void {
		// The same base latch the app keeps, for the same reason: the delta is measured
		// from where the gesture started, so it is added to the width it started from.
		columnBase ??= filesColumns[key];
		filesColumns = setFsColumnWidth(filesColumns, key, columnBase + delta, panelWidth);
		if (commit) columnBase = null;
	}

	/**
	 * ⚠ MORE ROWS THAN FIT, AND ONE NAME LONGER THAN ANY COLUMN WILL EVER BE. Whether a
	 * listing scrolls cannot be asserted on content that fits, and whether the name
	 * column truncates instead of pushing the numbers off the panel cannot be asserted
	 * on names that are short.
	 */
	const filesSource = {
		path: 'Project',
		home: '/home/pdmux',
		dropped: 0,
		truncated: false,
		error: null,
		entries: [
			{ name: 'node_modules', dir: true, symlink: false, size: 4096, modified: 1_784_000_000, mode: 0o755 },
			{
				name: 'a-single-unbroken-token-far-wider-than-this-column-will-ever-be.spec.ts',
				dir: false,
				symlink: false,
				size: 128_000,
				modified: 1_784_000_500,
				mode: 0o644,
			},
			...Array.from({ length: 40 }, (_, i) => ({
				name: `module-${i}.ts`,
				dir: false,
				symlink: false,
				size: 1024 * (i + 1),
				modified: 1_784_000_000 + i,
				mode: i % 3 === 0 ? 0o755 : 0o644,
			})),
			// ⚠ THE ICONS UPSTREAM SHIPS A LIGHT TWIN FOR. `file_type_yaml` is `#ffe885`
			// alone — luminance 0.90, invisible on a light card — and `config`, `toml`,
			// `json`, `rust` and `font` are the same argument to a lesser degree. A harness
			// full of TypeScript files would never show whether that swap works.
			{ name: 'ci.yaml', dir: false, symlink: false, size: 2048, modified: 1_784_000_100, mode: 0o644 },
			{ name: 'Cargo.toml', dir: false, symlink: false, size: 512, modified: 1_784_000_200, mode: 0o644 },
			{ name: 'main.rs', dir: false, symlink: false, size: 8192, modified: 1_784_000_300, mode: 0o644 },
			{ name: 'package.json', dir: false, symlink: false, size: 1536, modified: 1_784_000_400, mode: 0o644 },
			{ name: 'Dockerfile', dir: false, symlink: false, size: 640, modified: 1_784_000_600, mode: 0o644 },
			{ name: 'notes.md', dir: false, symlink: false, size: 4096, modified: 1_784_000_700, mode: 0o644 },
			{ name: 'photo.png', dir: false, symlink: false, size: 2_400_000, modified: 1_784_000_800, mode: 0o644 },
			{ name: 'quiet.bin', dir: false, symlink: false, size: 0, modified: 0, mode: 0 },
		],
	};

	/**
	 * ⚠ THE HARNESS SORTS, BECAUSE THE REAL CONSUMER DOES. `FileExplorer` draws the order
	 * it is given — the store that owns the listing also owns the selection, whose range
	 * is computed on array index. A harness that skipped this step showed a header
	 * reporting `Size ▼` above rows still in name order, which is exactly the bug a
	 * component-side sort would produce in the product.
	 */
	const filesDir = $derived({ ...filesSource, entries: sortFsEntries(filesSource.entries, filesSort) });
</script>

{#if screen === 'files'}
	<!-- A dock column's flex chain, at the width the spec asked for. `.pdmux-files` is
	     `flex: 1; min-height: 0`, so it needs a parent with a definite height or the
	     listing has no scroll container and the whole measurement is meaningless. -->
	<div
		class="pdmux"
		data-harness="files"
		style="width:{filesWidth}px;height:420px;display:flex;flex-direction:column"
	>
		<FileExplorer
			dir={filesDir}
			path="Project"
			sort={filesSort}
			columns={filesColumns}
			scheme={filesScheme}
			formatDate={(seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')}
			onSort={(key) => (filesSort = nextFsSort(filesSort, key))}
			onColumnResize={dragColumn}
		/>
	</div>
{:else if screen === 'tree'}
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
			// ⚠ TRUNCATED ON PURPOSE. The note it draws used to be auto-placed into the
			// line-number column and set that column's width — see the spec below.
			truncated: true,
		}}
	/>
</div>
{:else}
	<div
		class="pdmux pdmux-shell"
		data-harness-layout={JSON.stringify(layout)}
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
				paneClickAction={query.has('body-focus') ? 'focus' : undefined}
				onFocus={(slotId) => (layout = focusSlot(layout, slotId))}
				onReadHistory={historyAnswer}
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
