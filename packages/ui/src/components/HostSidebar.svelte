<script lang="ts">
	/**
	 * The column of host cards.
	 *
	 * It is a SCROLL CONTAINER of its own (`min-height:0; overflow:auto`) because the
	 * page around it must never scroll: the terminals own the rest of the viewport,
	 * and a page-level scrollbar would push them out of it.
	 */
	import type { Snippet } from 'svelte';
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
		/**
		 * Offer "add a host" as the LAST tile in the column, cards or no cards.
		 *
		 * A callback rather than a boolean, so the consumer's permission check and its
		 * dialog stay in one place: pass nothing and no tile is drawn. That is what a
		 * viewer without the right to change the fleet gets — a placeholder that leads
		 * to a 403 is worse than no placeholder.
		 */
		onAddHost?: () => void;
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
		onAddHost,
	}: Props = $props();

	const tr = $derived(translator(t));
</script>

<aside class="pdmux pdmux-sidebar" data-pdmux-sidebar aria-label={tr('pdmux.sidebar.label', 'hosts')}>
	{#if header}{@render header()}{/if}
	{#if cards.length}
		{#each cards as entry (entry.host.id)}
			<HostCard
				host={entry.host}
				agents={entry.agents}
				resources={entry.resources}
				history={entry.history}
				services={entry.services}
				prefs={entry.prefs}
				{now}
				{windowSec}
				{windowLabels}
				{t}
				{onOpenService}
				{onOpenSettings}
			/>
		{/each}
	{:else}
		<p class="pdmux-meta" data-pdmux-empty="hosts">{tr('pdmux.sidebar.empty', 'No hosts registered yet.')}</p>
	{/if}
	{#if onAddHost}
		<!-- OUTSIDE the if/else on purpose: this is the end of the list whether the list has
		     nine cards or none, and an empty fleet is exactly when it matters most — the
		     header's own add button is a 28px glyph, and "you have no hosts" with no way to
		     get one from where you are reading it is a dead end. It scrolls with the cards
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
	{#if footer}
		<!-- Sticky, not just last: with a fleet that overflows the column, a footer in
		     normal flow can only be reached by scrolling past every card. -->
		<div class="pdmux-sidebar-foot" data-pdmux-sidebar-foot>{@render footer()}</div>
	{/if}
</aside>
