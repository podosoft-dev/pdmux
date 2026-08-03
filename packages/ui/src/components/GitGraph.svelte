<script lang="ts">
	/**
	 * Read-only commit graph.
	 *
	 * READ-ONLY IS STRUCTURAL, not a setting: there is no checkout, merge, rebase,
	 * reset, fetch or push here — not disabled, absent. The component receives a
	 * snapshot and draws it.
	 *
	 * ⚠ The list is a SCROLL CONTAINER with a visible scrollbar. Overlay scrollbars
	 * hid the fact that a 300-row list had anything below the fold, and an unbounded
	 * list pushed the detail panel off screen entirely.
	 *
	 * ⚠ The lane SVG is an absolute overlay on the row stack, so the two MUST agree on
	 * how tall a row is. That number belongs to CSS (`--pdmux-row`, 40px under
	 * `@media (pointer: coarse)`), so it is MEASURED here and handed to the layout
	 * rather than assumed: when the geometry hard-coded 24 the overlay was `24n` tall
	 * over a `40n` list, and on every touch device the lanes and dots simply stopped
	 * about 60% of the way down.
	 */
	import {
		GEOM,
		type GraphEdge,
		type GraphRow,
		type RefInput,
		type UncommittedSummary,
		edgePath,
		graphSize,
		layoutGraph,
		refChips,
		remoteNames,
	} from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	interface CommitInput {
		sha: string;
		parents?: readonly string[];
		refs?: readonly string[];
		author?: string;
		date?: number | null;
		subject?: string;
	}

	interface Props {
		commits?: readonly CommitInput[];
		refs?: readonly RefInput[];
		/** Working-tree summary; when set, a dashed row is pinned above HEAD. */
		uncommitted?: UncommittedSummary | null;
		head?: string | null;
		selectedSha?: string | null;
		/** Formats a commit timestamp; the caller owns locale and timezone. */
		formatDate?: (epochSeconds: number) => string;
		/** Rendered in the working-tree row, e.g. "modified 11 · untracked 2". */
		uncommittedLabel?: string;
		t?: Translate;
		onSelect?: (sha: string) => void;
		/**
		 * Has an answer arrived? `false` means "not asked yet", and the difference is the
		 * whole point: an empty list rendered before the response says "there is nothing
		 * here" about something nobody has looked at. On a wide dock that reads as a
		 * blank column with a verdict in it, on every refresh. Defaults to `true` so a
		 * caller that renders from data it already holds is unaffected.
		 */
		ready?: boolean;
	}

	let {
		commits = [],
		refs = [],
		uncommitted = null,
		head = null,
		selectedSha = null,
		formatDate,
		uncommittedLabel = '',
		t,
		onSelect,
		ready = true,
	}: Props = $props();

	let rowsEl: HTMLDivElement | null = $state(null);
	// Widened deliberately: `GEOM` is `as const`, so an inferred `rowHeight` would be the
	// literal 24 and a measured height could never be assigned to it.
	let rowHeight = $state<number>(GEOM.row);
	/** Plain, NOT `$state`: read inside the effect below, where tracking it would re-run it. */
	let measured: number = GEOM.row;

	// Server render and first paint use the default; the measurement corrects it on mount,
	// before the browser paints. A media query cannot reach the SVG's `d` attributes, so
	// there is no declarative version of this.
	$effect(() => {
		const host = rowsEl;
		if (!host) return;
		const measure = (): void => {
			const first = host.querySelector<HTMLElement>('.pdmux-graph-row');
			const next = first ? first.getBoundingClientRect().height : 0;
			// Sub-pixel jitter (zoom, fractional DPR) must not re-lay-out the whole graph.
			if (next > 0 && Math.abs(next - measured) >= 0.5) {
				measured = next;
				rowHeight = next;
			}
		};
		measure();
		// The host's own height changes whenever a row's does, which is the only thing worth
		// re-measuring for — the row count changing costs one no-op measure. Guarded like
		// `TerminalPane`: jsdom has none, and the single measurement above still stands.
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(host);
		return () => observer.disconnect();
	});

	let listEl: HTMLDivElement | null = $state(null);
	/** The list's height last time we looked, so a resize can be read as grow or shrink. */
	let lastListHeight = 0;

	/**
	 * Keep the selected row on screen when the detail panel takes its space.
	 *
	 * REPORTED: selecting one of the last visible commits opened the panel underneath and
	 * the panel covered the row that opened it. The list and the detail share one column,
	 * so opening the panel SHRINKS the list — the row does not move, the floor rises past
	 * it.
	 *
	 * Only a shrink triggers this, and only for a row that was on screen BEFORE it. That
	 * is the difference between following the panel and fighting the user: selecting a
	 * commit, scrolling away, then dragging the splitter must not yank the list back to a
	 * selection that is nowhere near the viewport. `block: 'nearest'` then moves the
	 * minimum needed and does nothing at all to a row that is already fully visible.
	 *
	 * ⚠ ONE adjustment per settle, not one per resize. The panel does not arrive in a
	 * single layout pass — measured opening it: 755 -> 609 -> 389 — and correcting on each
	 * step scrolled the list twice, which reads as a lurch rather than as the row moving
	 * up with the panel. The frame is coalesced and the "was it on screen" test is made
	 * against the height BEFORE the first step, so the end position is identical and only
	 * the stutter goes.
	 */
	$effect(() => {
		const list = listEl;
		if (!list) return;
		lastListHeight = list.clientHeight;
		if (typeof ResizeObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') return;

		let frame = 0;
		/** The height before the CURRENT run of shrinks — not before the last step of it. */
		let shrankFrom = 0;
		const reveal = (): void => {
			frame = 0;
			const row = list.querySelector<HTMLElement>('.pdmux-graph-row[aria-current="true"]');
			if (!row) return;
			// Measured against the list's top edge, which a shrink does not move — the
			// panel takes space from the bottom.
			const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
			const bottom = top + row.offsetHeight;
			const wasOnScreen = top >= 0 && bottom <= shrankFrom;
			if (wasOnScreen && bottom > list.clientHeight) row.scrollIntoView({ block: 'nearest' });
		};

		const observer = new ResizeObserver(() => {
			const height = list.clientHeight;
			const shrank = height < lastListHeight - 0.5;
			if (!frame) shrankFrom = lastListHeight;
			lastListHeight = height;
			if (!shrank) return;
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(reveal);
		});
		observer.observe(list);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});

	const tr = $derived(translator(t));
	const graph = $derived(layoutGraph(commits, { uncommitted: Boolean(uncommitted), head, rowHeight }));
	const size = $derived(graphSize(graph, rowHeight));
	const remotes = $derived(remoteNames(refs));
	const commitOf = (sha: string): CommitInput | undefined => commits.find((c) => c.sha === sha);
	const dateOf = (epoch: number | null | undefined): string =>
		epoch == null ? '' : (formatDate ?? ((s: number) => new Date(s * 1000).toISOString().slice(0, 16)))(epoch);
	const pathOf = (edge: GraphEdge, rows: readonly GraphRow[]): string => edgePath(edge, rows, rowHeight);
</script>

<div class="pdmux pdmux-graph-list" data-pdmux-graph tabindex="-1" bind:this={listEl}>
	{#if graph.rows.length}
		<div class="pdmux-graph-rows" style="--pdmux-graph-w:{size.width}px" bind:this={rowsEl}>
			<svg
				class="pdmux-graph-svg"
				width={size.width}
				height={size.height}
				viewBox="0 0 {size.width} {size.height}"
				aria-hidden="true"
			>
				{#each graph.edges as edge (edge.from + edge.to + edge.toLane)}
					{@const d = pathOf(edge, graph.rows)}
					{#if d}
						<path
							class="pdmux-edge"
							{d}
							stroke={edge.color}
							data-open={edge.open ? 'true' : 'false'}
							data-dashed={edge.dashed ? 'true' : 'false'}
						/>
					{/if}
				{/each}
				{#each graph.rows as row (row.sha)}
					<circle
						class="pdmux-dot"
						cx={row.x}
						cy={row.y}
						r={GEOM.dot}
						fill={row.kind === 'uncommitted' ? 'transparent' : row.color}
						stroke={row.color}
						data-kind={row.kind}
					/>
				{/each}
			</svg>

			{#each graph.rows as row (row.sha)}
				{@const commit = row.kind === 'commit' ? commitOf(row.sha) : undefined}
				<button
					class="pdmux-graph-row"
					class:pdmux-wip={row.kind === 'uncommitted'}
					type="button"
					data-pdmux-sha={row.sha}
					aria-current={selectedSha === row.sha}
					onclick={() => onSelect?.(row.sha)}
				>
					<span class="pdmux-graph-subject">
						{row.kind === 'uncommitted'
							? `${tr('pdmux.graph.uncommitted', 'Uncommitted changes')}${uncommittedLabel ? ` — ${uncommittedLabel}` : ''}`
							: (commit?.subject ?? '')}
					</span>
					<span class="pdmux-graph-chips">
						{#each refChips(commit?.refs, remotes) as chip (chip.kind + chip.label)}
							<span class="pdmux-graph-chip" data-kind={chip.kind}>{chip.label}</span>
						{/each}
					</span>
					<span class="pdmux-graph-author">{row.kind === 'uncommitted' ? '' : (commit?.author ?? '')}</span>
					<span class="pdmux-graph-date">{row.kind === 'uncommitted' ? '' : dateOf(commit?.date)}</span>
					<span class="pdmux-graph-sha">{row.kind === 'uncommitted' ? '' : row.sha.slice(0, 7)}</span>
				</button>
			{/each}
		</div>
	{:else if ready}
		<!-- Only once there IS an answer — see `ready`. -->
		<p class="pdmux-meta" data-pdmux-empty="graph">{tr('pdmux.graph.empty', 'No commits')}</p>
	{/if}
</div>
