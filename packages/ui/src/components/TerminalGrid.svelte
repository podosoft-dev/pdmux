<script lang="ts">
	/**
	 * The grid of positional cells.
	 *
	 * A pane element is created ONCE per slot and then kept mounted while it scrolls
	 * off the current page — moving it would reconnect its terminal. Paging and zoom
	 * only flip visibility and CSS order, and the grid's auto-placement lays the
	 * visible ones out in cell order.
	 *
	 * The exception, and the reason it exists: a mounted terminal holds a live session
	 * client, and an idle-stop policy counts any attached client as activity — a
	 * forgotten tab would keep hosts awake forever. Hidden panes are therefore
	 * released after a TTL, a cell that no longer exists is released at once, and a
	 * count cap evicts the oldest hidden ones.
	 */
	import { untrack, type Snippet } from 'svelte';
	import {
		GRID_COLUMNS,
		type CellRect,
		type ClickAction,
		type GridHost,
		type TerminalLayout,
		type TerminalSlot,
		dropTargetIndex,
		emptyCellKind,
		isSlotReachable,
		orphanPaneIds,
		soloIndex,
		stalePaneIds,
		visibleIndexes,
		visibleSlots,
		type HistoryLine,
	} from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import type { TerminalPaneActionContext } from '../types.js';
	import type { TerminalAdapter } from '../adapters/terminal-adapter.js';
	import type { TerminalSurfaceFactory } from '../adapters/terminal-surface.js';
	import EmptyCell from './EmptyCell.svelte';
	import TerminalPane from './TerminalPane.svelte';

	interface Props {
		layout: TerminalLayout;
		hosts?: readonly GridHost[];
		adapter: TerminalAdapter;
		createSurface?: TerminalSurfaceFactory;
		/** How long a hidden pane may keep its session client. */
		idleTtlMs?: number;
		maxPanes?: number;
		/** How often the eviction rules are applied. 0 disables the timer (tests). */
		sweepMs?: number;
		/**
		 * False while the whole grid is off screen — a narrow screen showing another tab.
		 *
		 * ⚠ It is passed straight to the panes and NEVER mixed into `visibleIds`. That set
		 * drives the hidden-pane bookkeeping below, and `stalePaneIds` releases a pane that
		 * has been hidden for ten minutes: an in-app tab switch would then detach every
		 * session while the user reads the commit graph, and a plain `shell` pane would take
		 * its work with it. Switching tabs is not the user walking away.
		 */
		onScreen?: boolean;
		/** Show each live pane's soft-keyboard helper row (a phone). */
		keyBar?: boolean;
		t?: Translate;
		onAssign?: (index: number, anchor: HTMLElement) => void;
		onClose?: (index: number) => void;
		onRemove?: (index: number) => void;
		onZoom?: (slotId: string) => void;
		onFocus?: (slotId: string) => void;
		onDetach?: (slot: TerminalSlot) => void;
		/** Override the persisted click preference without changing the serialized layout. */
		paneClickAction?: ClickAction;
		/** App-owned pane header controls, forwarded without changing package defaults. */
		paneActions?: Snippet<[TerminalPaneActionContext]>;
		onSwap?: (from: number, to: number) => void;
		onExit?: (slotId: string, code: number | null) => void;
		/** Passed straight to every pane — see `TerminalPane` for why the app owns these. */
		onScrollback?: (slot: TerminalSlot, action: "enter" | "exit") => void;
		/** Draw the gesture readout over every pane. See `TerminalPane`; off by default. */
		diagnostics?: boolean;
		/** What the transport is doing — every pane says so while it is not `open`. */
		transport?: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
		/** Passed straight to the pane — `null` means the ask failed. See `TerminalPane`. */
		onReadHistory?: (
			slot: TerminalSlot,
		) => Promise<{ lines: HistoryLine[]; scrollback: boolean; screenOnly?: boolean } | null>;
	}

	let {
		layout,
		hosts = [],
		adapter,
		createSurface,
		idleTtlMs = 10 * 60_000,
		maxPanes = 12,
		sweepMs = 30_000,
		onScreen = true,
		keyBar = false,
		t,
		onAssign,
		onClose,
		onRemove,
		onZoom,
		onFocus,
		onDetach,
		paneClickAction,
		paneActions,
		onSwap,
		onExit,
		onScrollback,
		onReadHistory,
		diagnostics = false,
		transport = 'open',
	}: Props = $props();

	const tr = $derived(translator(t));
	const cells = $derived(visibleSlots(layout));
	const indexes = $derived(visibleIndexes(layout));
	const columns = $derived(layout.zoomId ? 1 : (GRID_COLUMNS[layout.mode] ?? 2));
	/**
	 * Exactly one cell on screen: a phone (whose shell projects `soloLayout`, i.e. `tab`
	 * mode), a `tab` split, or a zoom. The panes need to know, because a touch pane that is
	 * the ONLY pane on screen must show its composer without waiting for a tap — nothing is
	 * focused on a phone until a finger lands. See `TerminalPane`'s `touchBar`.
	 */
	const solo = $derived(cells.length === 1);
	/**
	 * The one cell a single-column screen keeps. `null` means "everything shows" — a
	 * window of one (a phone's projected layout, a zoom) needs no marking, and marking
	 * it wrongly would hide the only pane on screen. The anchor must be IN the current
	 * window: focus can sit on another page, and an anchor nobody renders would blank
	 * the whole grid below the breakpoint.
	 */
	const stackAnchor = $derived.by(() => {
		if (cells.length <= 1) return null;
		const anchor = soloIndex(layout);
		return indexes.includes(anchor) ? anchor : (indexes[0] ?? 0);
	});
	const visibleIds = $derived(new Set(cells.filter(Boolean).map((slot) => (slot as TerminalSlot).id)));

	/**
	 * Slots with a live pane element, in mount order.
	 *
	 * ⚠ SEEDED FROM THE FIRST WINDOW, NOT EMPTY. The `$effect` below is what maintains
	 * this list, and an effect runs AFTER the first render (and never during SSR). So an
	 * empty initial value means the very first paint draws a grid containing only the
	 * EMPTY cells — the filled ones render nothing at all, and CSS Grid collapses to as
	 * many tracks as there are children. A saved 3x3 with six terminals therefore paints
	 * as three full-height empty columns for ~400ms and then snaps into place: reported
	 * as "the layout is wrong after a refresh, and switching tabs fixes it" (a tab switch
	 * simply gave the effect time to run). On a phone the same gap shows the whole split
	 * before it collapses to one pane.
	 *
	 * Seeding costs nothing — the effect immediately agrees with this value — and it is
	 * the difference between a first paint that is right and one that is thrown away.
	 */
	// `untrack`: capturing the FIRST window is the whole point — this is a seed, not a
	// subscription. The effect below owns every update after it.
	let mounted = $state<TerminalSlot[]>(
		untrack(() => cells.filter((slot): slot is TerminalSlot => Boolean(slot))),
	);
	/** slot id -> epoch ms it went off screen (absent while visible). */
	let hiddenAt = $state<Record<string, number>>({});

	$effect(() => {
		const ids = visibleIds;
		const slots = layout.slots;
		const current = untrack(() => mounted);
		const next = [...current];
		for (const slot of cells) {
			if (slot && !next.some((m) => m.id === slot.id)) next.push(slot);
		}
		// A cell that no longer exists can never come back: release it now rather than
		// after the TTL, so its session client detaches when the user expects it to.
		const orphans = new Set(orphanPaneIds(next.map((m) => m.id), slots));
		const kept = next.filter((m) => !orphans.has(m.id));
		if (kept.length !== current.length || kept.some((m, i) => m.id !== current[i]?.id)) mounted = kept;

		const stamps = untrack(() => hiddenAt);
		const updated: Record<string, number> = {};
		for (const slot of kept) {
			if (ids.has(slot.id)) continue;
			updated[slot.id] = stamps[slot.id] ?? Date.now();
		}
		const sameSize = Object.keys(updated).length === Object.keys(stamps).length;
		if (!sameSize || Object.keys(updated).some((id) => stamps[id] !== updated[id])) hiddenAt = updated;
	});

	function sweep(): void {
		const stale = new Set(
			stalePaneIds(
				mounted.map((slot) => ({ id: slot.id, hiddenSince: hiddenAt[slot.id] ?? null })),
				Date.now(),
				{ ttlMs: idleTtlMs, max: maxPanes },
			),
		);
		if (!stale.size) return;
		mounted = mounted.filter((slot) => !stale.has(slot.id));
	}

	$effect(() => {
		if (!sweepMs) return;
		const timer = setInterval(sweep, sweepMs);
		return () => clearInterval(timer);
	});

	let root = $state<HTMLDivElement | null>(null);
	let dragFrom = $state<number | null>(null);
	let dropIndex = $state<number | null>(null);
	let rects: CellRect[] = [];

	/**
	 * Cell rects are measured ONCE per drag: the pointer is captured on the header, so
	 * everything after `pointerdown` is resolved from these rectangles rather than
	 * from the element under the pointer (an embedded terminal would swallow that).
	 */
	function measure(): CellRect[] {
		if (!root) return [];
		return [...root.querySelectorAll<HTMLElement>('[data-pdmux-cell]')]
			.filter((node) => !node.hasAttribute('hidden'))
			.map((node) => ({ index: Number(node.dataset.pdmuxCell), rect: node.getBoundingClientRect() }));
	}

	const hostName = (hostId: string): string => hosts.find((h) => h.id === hostId)?.name ?? hostId;
	/** Window position of a mounted slot, or -1 while it is off screen. */
	const windowPosition = (slotId: string): number => cells.findIndex((cell) => cell?.id === slotId);
	const cellIndexOf = (slotId: string): number => {
		const position = windowPosition(slotId);
		return position >= 0 ? (indexes[position] ?? position) : layout.slots.findIndex((slot) => slot?.id === slotId);
	};
</script>

<div
	class="pdmux pdmux-grid"
	bind:this={root}
	style="--pdmux-cols:{columns}"
	data-pdmux-grid
	data-pdmux-mode={layout.mode}
	aria-label={tr('pdmux.grid.label', 'terminals')}
>
	{#each mounted as slot (slot.id)}
		<TerminalPane
			{slot}
			index={cellIndexOf(slot.id)}
			hostName={hostName(slot.hostId)}
			{adapter}
			{createSurface}
			{t}
			reachable={isSlotReachable(slot, hosts)}
			zoomed={layout.zoomId === slot.id}
			focused={layout.focusId === slot.id}
			visible={visibleIds.has(slot.id)}
			stackAnchor={stackAnchor === null || cellIndexOf(slot.id) === stackAnchor}
			{onScreen}
			{keyBar}
			{solo}
			order={Math.max(0, windowPosition(slot.id))}
			dragging={dragFrom === cellIndexOf(slot.id)}
			dropTarget={dropIndex === cellIndexOf(slot.id) && dropIndex !== dragFrom}
			clickAction={paneClickAction ?? layout.clickAction}
			actions={paneActions}
			{onAssign}
			{onZoom}
			{onFocus}
			{onClose}
			{onDetach}
			{onExit}
			{onScrollback}
			{onReadHistory}
			{diagnostics}
			{transport}
			onDragStart={(index) => {
				dragFrom = index;
				rects = measure();
			}}
			onDragMove={(_index, point) => (dropIndex = dropTargetIndex(rects, point))}
			onDragEnd={(index, point) => {
				const target = dropTargetIndex(rects, point);
				if (target != null && target !== index) onSwap?.(index, target);
				dragFrom = null;
				dropIndex = null;
			}}
		/>
	{/each}

	{#each cells as cell, position (indexes[position])}
		{#if !cell}
			{@const index = indexes[position] ?? position}
			<EmptyCell
				{index}
				order={position}
				kind={emptyCellKind(layout, index) === 'hole' ? 'hole' : 'padding'}
				stackAnchor={stackAnchor === null || index === stackAnchor}
				dropTarget={dropIndex === index && dropIndex !== dragFrom}
				{t}
				{onAssign}
				{onRemove}
			/>
		{/if}
	{/each}
</div>
