<script lang="ts">
	/**
	 * Per-card widget toggles, and nothing else the host's own page already answers.
	 *
	 * Three rules this popover had to learn, all from real misbehaviour:
	 *  1. a click INSIDE must not reach the document handler — re-rendering detaches
	 *     the clicked node, which then reads as an outside click and closes it;
	 *  2. the trigger counts as "inside", or the opener closes what it just opened;
	 *  3. the box is clamped to the viewport, or opening it near an edge puts it
	 *     off screen.
	 * ⚠ IT IS AN ENTRY POINT, NOT A CONTAINER. It grew to fifteen
	 * rows — five reference values and six actions — and all but the switches were a
	 * second copy of the host page. Two of them were the same testid as the buttons on
	 * that page. What is left is what a 260px panel beside a card is for: flip a widget,
	 * see whether the machine is answering, and leave.
	 */
	import type { Snippet } from 'svelte';
	import { CARD_WIDGETS, type CardPrefs, type CardWidget } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	interface Props {
		hostName: string;
		prefs: CardPrefs;
		/**
		 * One line under the name: is this machine answering, and when did it last.
		 *
		 * ⚠ IT REPLACED FIVE READ-ONLY ROWS. Address, agent version, os/arch, last seen
		 * and a copyable `ssh` line all lived here, and every one of them is on the
		 * host's own page — so the panel spent two thirds of its height restating what
		 * a click away already said, and the three switches that are the only thing it
		 * can actually change were pushed below the fold on a short screen.
		 */
		status?: string;
		/** Viewport coordinates of the trigger's bottom-left corner. */
		anchor?: { x: number; y: number };
		width?: number;
		labels?: Partial<Record<CardWidget, string>>;
		t?: Translate;
		/**
		 * What this card lets you DO, pinned under the toggles — the consuming app's
		 * business, so it arrives as a slot rather than as buttons of our own.
		 *
		 * The one that exists today is "delete this host", and it is the reason the slot
		 * is not a `onDelete` prop: an irreversible action needs a confirmation, a typing
		 * gate, an API call and the wording that goes with losing tokens — none of which
		 * belongs in a package that only knows how to draw. The package supplies the
		 * place; the app supplies the judgement. Omitted (a member, who may look at the
		 * fleet but not change it) nothing is rendered at all.
		 */
		actions?: Snippet;
		onToggle?: (widget: CardWidget) => void;
		onClose?: () => void;
	}

	let {
		hostName,
		prefs,
		status = '',
		anchor = { x: 8, y: 8 },
		width = 260,
		labels = {},
		t,
		actions,
		onToggle,
		onClose,
	}: Props = $props();

	const tr = $derived(translator(t));
	const fallback: Record<CardWidget, string> = {
		agents: 'Agents',
		resources: 'Resources (CPU/MEM/DISK)',
		links: 'Service links',
	};

	let box = $state<HTMLDivElement | null>(null);
	/**
	 * Bound rather than read once.
	 *
	 * The clamp used to read `globalThis.innerWidth` inside a `$derived` with nothing to
	 * invalidate it, so a phone rotated with the popover open kept a position computed for
	 * the old viewport. Binding makes the window a reactive input.
	 */
	let viewportW = $state(typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 0);
	let viewportH = $state(typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 0);

	/**
	 * Never wider than the screen: the clamp below can only MOVE the box, so a fixed 260px
	 * popover on a 320px phone hung off the right edge no matter where it was anchored.
	 */
	const boxWidth = $derived(viewportW > 0 ? Math.min(width, viewportW - 16) : width);

	// Clamped against the measured box, so a card near the bottom edge still shows a
	// complete popover.
	const position = $derived.by(() => {
		const w = box?.offsetWidth || boxWidth;
		const h = box?.offsetHeight || 200;
		const screenW = viewportW || w + 16;
		const screenH = viewportH || h + 16;
		return {
			left: Math.max(8, Math.min(anchor.x, screenW - w - 8)),
			top: Math.max(8, Math.min(anchor.y, screenH - h - 8)),
		};
	});
</script>

<svelte:window bind:innerWidth={viewportW} bind:innerHeight={viewportH} />

<div
	class="pdmux pdmux-popover"
	bind:this={box}
	role="dialog"
	tabindex="-1"
	aria-label={tr('pdmux.card.settingsFor', 'card settings')}
	data-pdmux-popover="card-settings"
	style="left:{position.left}px;top:{position.top}px;width:{boxWidth}px"
	onclick={(event) => event.stopPropagation()}
	onkeydown={(event) => {
		if (event.key === 'Escape') onClose?.();
	}}
>
	<!--
		Two bands, divided by a full-bleed rule: who this is, and what you can change about
		it. There used to be a third — five read-only reference rows between them — and it
		is the reason nothing said that the switches were the only part of this panel that
		did anything. They are all on the host's own page; this one says only whether the
		machine is answering, which is the question you open a card to ask.
	-->
	<div class="pdmux-popover-head">
		<div class="pdmux-popover-title">{hostName}</div>
		{#if status}
			<div class="pdmux-popover-sub" data-pdmux-status>{status}</div>
		{/if}
	</div>
	<div class="pdmux-popover-rule"></div>
	<div class="pdmux-popover-widgets">
		{#each CARD_WIDGETS as widget (widget)}
			<!--
				Label first, control last. A preference reads as a sentence about the card and
				the answer belongs at the end of the line, which is also what puts every
				switch on one axis instead of ragged behind labels of different lengths.
			-->
			<label class="pdmux-toggle">
				<span class="pdmux-toggle-label"
					>{tr(`pdmux.widget.${widget}`, labels[widget] ?? fallback[widget])}</span
				>
				<input
					class="pdmux-switch"
					type="checkbox"
					role="switch"
					checked={prefs[widget]}
					data-pdmux-toggle={widget}
					onchange={() => onToggle?.(widget)}
				/>
			</label>
		{/each}
	</div>
	{#if actions}
		<!-- Last, and below the harmless toggles: the popover is where you *look* at a
		     card, so anything that changes the fleet sits at the far end of it rather
		     than one row away from a switch — behind a rule that says so. What the app
		     renders keeps its own looks; only the place and the spacing are ours. -->
		<div class="pdmux-popover-rule"></div>
		<div data-pdmux-popover-acts>{@render actions()}</div>
	{/if}
</div>
