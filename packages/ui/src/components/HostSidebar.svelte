<script lang="ts">
	/**
	 * The column of host cards.
	 *
	 * It is a SCROLL CONTAINER of its own (`min-height:0; overflow:auto`) because the
	 * page around it must never scroll: the terminals own the rest of the viewport,
	 * and a page-level scrollbar would push them out of it.
	 */
	import { type Snippet, tick } from 'svelte';
	import type { AgentRow, CardPrefs, HostSeries, ServiceOption } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import type { HostResources, HostSummary } from '../types.js';
	import HostCard from './HostCard.svelte';

	interface CardEntry {
		host: HostSummary;
		agents?: readonly AgentRow[];
		resources?: HostResources;
		history?: HostSeries | null;
		services?: readonly ServiceOption[];
		prefs?: CardPrefs;
		/** Folded to its header. Resolved by the consumer, one entry at a time. */
		collapsed?: boolean;
		/** Terminal cells open on this host (0-based, as the pane headers number them). */
		panes?: readonly number[];
	}

	interface Props {
		cards?: readonly CardEntry[];
		now?: number;
		windowSec?: number;
		windowLabels?: Record<string, string>;
		t?: Translate;
		header?: Snippet;
		/**
		 * Pinned to the bottom of the column (an account block, a status line, …).
		 * The package supplies the slot and its geometry only — what goes in it is the
		 * consuming app's business, and nothing account-shaped belongs here.
		 */
		footer?: Snippet;
		onOpenService?: (url: string, hostId: string) => void;
		onOpenSettings?: (hostId: string, anchor: HTMLElement) => void;
		/** Absent = no card draws a fold control. */
		onToggleCollapse?: (hostId: string) => void;
		onUpdateAgent?: (hostId: string, anchor: HTMLElement) => void;
		/**
		 * Offer "add a host" as the LAST tile in the column, cards or no cards.
		 *
		 * A callback rather than a boolean, so the consumer's permission check and its
		 * dialog stay in one place: pass nothing and no tile is drawn. That is what a
		 * viewer without the right to change the fleet gets — a placeholder that leads
		 * to a 403 is worse than no placeholder.
		 */
		onAddHost?: () => void;
		/**
		 * Whether the consumer can reach its server. Anything but `online` puts a notice at the
		 * top of the column and greys the cards: the rows are the last answer, not a current one.
		 * The consumer is also expected to pass each card as `unknown` meanwhile — this marks the
		 * column, it does not rewrite the hosts.
		 */
		connection?: 'online' | 'reconnecting' | 'offline';
		/**
		 * Move the card drawn at `from` to `to` (indexes into `cards`). Absent = no grip and
		 * no reordering. Called once per drop or arrow key, never while the pointer moves.
		 */
		onMove?: (from: number, to: number) => void;
		/** A terminal number on a card was pressed. Absent = the numbers are plain text. */
		onOpenPane?: (index: number) => void;
	}

	let {
		cards = [],
		now,
		windowSec = 3600,
		windowLabels = {},
		t,
		header,
		footer,
		onOpenService,
		onOpenSettings,
		onToggleCollapse,
		onUpdateAgent,
		onAddHost,
		connection = 'online',
		onMove,
		onOpenPane,
	}: Props = $props();

	const tr = $derived(translator(t));

	/**
	 * The scrollbar width this platform reserves, for the stylesheet's right padding
	 * (`--pdmux-sidebar-gutter`, see `.pdmux-sidebar`). It is measured because it is not
	 * a constant: 11px in Mac Chrome, 10px in Chromium on Linux, 0 for an overlay
	 * scrollbar. Zoom changes it in CSS pixels, and the content box with it, so the
	 * observer measures again.
	 */
	let sidebar: HTMLElement | null = $state(null);
	let gutter: number | null = $state(null);
	$effect(() => {
		const element = sidebar;
		if (!element) return;
		const measure = (): void => {
			const style = getComputedStyle(element);
			const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
			gutter = Math.max(0, element.offsetWidth - element.clientWidth - borders);
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});

	/*
	 * Reordering. The column owns the gesture because only the column knows where every
	 * card is; a card reports a press on its grip and arrow keys, nothing else.
	 *
	 * ⚠ NOTHING MOVES UNTIL THE DROP. Re-sorting under the pointer would save a position
	 * per pixel and shuffle the very rectangles the next move is measured against. The
	 * carried card steps back, a line marks where it will land, and one `onMove` fires on
	 * release. While the server is unreachable nothing can be saved, so nothing starts.
	 */
	const canMove = $derived(onMove !== undefined && connection === 'online');
	let carry = $state<{ hostId: string; from: number; startY: number; started: boolean } | null>(null);
	let gap = $state<number | null>(null);
	let announcement = $state('');

	const target = $derived.by(() => {
		if (!carry?.started || gap === null) return null;
		const to = gap > carry.from ? gap - 1 : gap;
		return to === carry.from ? null : to;
	});

	function dropSide(index: number): 'before' | 'after' | null {
		if (target === null || gap === null) return null;
		if (gap === index) return 'before';
		if (gap === cards.length && index === cards.length - 1) return 'after';
		return null;
	}

	function cardElements(): HTMLElement[] {
		return sidebar ? Array.from(sidebar.querySelectorAll<HTMLElement>(':scope > [data-pdmux-host]')) : [];
	}

	function startCarry(hostId: string, event: PointerEvent): void {
		if (!canMove || event.button !== 0) return;
		const from = cards.findIndex((entry) => entry.host.id === hostId);
		if (from < 0) return;
		event.preventDefault();
		carry = { hostId, from, startY: event.clientY, started: false };
		gap = null;
		window.addEventListener('pointermove', moveCarry);
		window.addEventListener('pointerup', endCarry);
		window.addEventListener('pointercancel', cancelCarry);
	}

	function moveCarry(event: PointerEvent): void {
		if (!carry) return;
		// A few pixels of slack, so a click on the grip is a click and not a drop in place.
		if (!carry.started && Math.abs(event.clientY - carry.startY) < 4) return;
		carry.started = true;
		const rects = cardElements().map((element) => element.getBoundingClientRect());
		let next = rects.length;
		for (let index = 0; index < rects.length; index++) {
			const rect = rects[index];
			if (rect && event.clientY < rect.top + rect.height / 2) {
				next = index;
				break;
			}
		}
		gap = next;
	}

	function stopListening(): void {
		window.removeEventListener('pointermove', moveCarry);
		window.removeEventListener('pointerup', endCarry);
		window.removeEventListener('pointercancel', cancelCarry);
	}

	function endCarry(): void {
		const from = carry?.from;
		const to = target;
		stopListening();
		carry = null;
		gap = null;
		if (from !== undefined && to !== null) {
			onMove?.(from, to);
			announce(to);
		}
	}

	function cancelCarry(): void {
		stopListening();
		carry = null;
		gap = null;
	}

	$effect(() => () => stopListening());

	function announce(to: number): void {
		announcement = tr('pdmux.card.moved', 'Moved to position {n}').replaceAll('{n}', String(to + 1));
	}

	async function keyMove(hostId: string, delta: -1 | 1): Promise<void> {
		if (!canMove) return;
		const from = cards.findIndex((entry) => entry.host.id === hostId);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= cards.length) return;
		onMove?.(from, to);
		announce(to);
		// The keyed card moves in the DOM, and a moved element can lose focus; keep it on
		// the grip so the next arrow press moves the same card again.
		await tick();
		cardElements()
			.find((element) => element.dataset.pdmuxHost === hostId)
			?.querySelector<HTMLElement>('[data-pdmux-grip]')
			?.focus();
	}
</script>

<aside
	class="pdmux pdmux-sidebar"
	data-pdmux-sidebar
	aria-label={tr('pdmux.sidebar.label', 'hosts')}
	bind:this={sidebar}
	style:--pdmux-sidebar-gutter={gutter === null ? undefined : `${gutter}px`}
	data-pdmux-connection={connection}
	data-pdmux-reordering={carry?.started ? 'true' : undefined}
>
	{#if header}{@render header()}{/if}
	{#if connection !== 'online'}
		<!-- Under the header and above the first card: the one place a glance at the column
		     lands before it reads any host as up or down. -->
		<p class="pdmux-sidebar-notice" data-pdmux-sidebar-notice={connection} role="status" aria-live="polite">
			{tr('pdmux.sidebar.connectionLost', 'Server connection lost — status unknown')}
		</p>
	{/if}
	{#if cards.length}
		{#each cards as entry, index (entry.host.id)}
			<HostCard
				host={entry.host}
				agents={entry.agents}
				resources={entry.resources}
				history={entry.history}
				services={entry.services}
				prefs={entry.prefs}
				collapsed={entry.collapsed}
				{now}
				{windowSec}
				{windowLabels}
				{t}
				{onOpenService}
				{onOpenSettings}
				{onToggleCollapse}
				{onUpdateAgent}
				panes={entry.panes}
				{onOpenPane}
				onGripPointerDown={onMove ? startCarry : undefined}
				onGripKey={onMove ? keyMove : undefined}
				dragging={carry?.started === true && carry.hostId === entry.host.id}
				drop={dropSide(index)}
			/>
		{/each}
	{:else}
		<p class="pdmux-meta" data-pdmux-empty="hosts">{tr('pdmux.sidebar.empty', 'No hosts registered yet.')}</p>
	{/if}
	{#if onAddHost}
		<!-- OUTSIDE the if/else on purpose: this is the end of the list whether the list has
		     nine cards or none, and an empty fleet is exactly when it matters most —
		     "you have no hosts" with no way to get one from where you are reading it is a
		     dead end. It scrolls with the cards
		     rather than pinning like the footer slot, because it IS the last card. -->
		<!-- ⚠ NOT `.pdmux-card`. It is card-SHAPED, and reusing the class made it a card to
		     every query that has ever been written against one: two geometry specs walk
		     `.pdmux-card` and read a name and a reachability glyph out of each, and both
		     failed on a tile that has neither. The look is shared through CSS, the identity
		     is not. -->
		<button type="button" class="pdmux pdmux-card-add" data-pdmux-add-host onclick={() => onAddHost?.()}>
			<span class="pdmux-card-add-mark" aria-hidden="true">+</span>
			<span>{tr('pdmux.sidebar.add', 'Add host')}</span>
		</button>
	{/if}
	<p class="pdmux-sr-only" aria-live="polite" data-pdmux-reorder-status>{announcement}</p>
	{#if footer}
		<!-- Sticky, not just last: with a fleet that overflows the column, a footer in
		     normal flow can only be reached by scrolling past every card. -->
		<div class="pdmux-sidebar-foot" data-pdmux-sidebar-foot>{@render footer()}</div>
	{/if}
</aside>
