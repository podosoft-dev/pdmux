<script lang="ts">
	/**
	 * An empty grid cell.
	 *
	 * It wears the SAME header as a filled pane so the grid reads consistently, and
	 * because closing a terminal must leave a first-class place you can fill, close or
	 * drag onto — not a gap.
	 *
	 * A HOLE (a cell inside the array) can be removed because following panes can move
	 * forward. PADDING (drawn past the end to fill the window) has no close action at
	 * all — an unavailable icon is visual noise, not information.
	 */
	import SquareDashedIcon from '@lucide/svelte/icons/square-dashed';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { type Translate, translator } from '../i18n.js';

	interface Props {
		index: number;
		kind: 'hole' | 'padding';
		/** CSS order, so an empty cell keeps its position in the window. */
		order?: number;
		dropTarget?: boolean;
		/** See TerminalPane's prop of the same name — one cell shows below the stack breakpoint. */
		stackAnchor?: boolean;
		t?: Translate;
		onAssign?: (index: number, anchor: HTMLElement) => void;
		onRemove?: (index: number) => void;
	}

	let { index, kind, order = 0, dropTarget = false, stackAnchor = true, t, onAssign, onRemove }: Props = $props();

	const tr = $derived(translator(t));
	const removable = $derived(kind === 'hole');
</script>

<div
	class="pdmux pdmux-pane pdmux-pane-empty"
	class:pdmux-drop={dropTarget}
	data-pdmux-cell={index}
	data-pdmux-stack={stackAnchor ? 'anchor' : 'rest'}
	data-pdmux-kind={kind}
	style="order:{order}"
>
	<div class="pdmux-pane-head">
		<span class="pdmux-pane-heading">
			<span class="pdmux-pane-label">
				<SquareDashedIcon class="pdmux-pane-title-icon" aria-hidden="true" />
				<span class="pdmux-pane-index">#{index + 1}</span>
				<span class="pdmux-pane-target">{tr('pdmux.cell.empty', 'empty')}</span>
			</span>
		</span>
		<span class="pdmux-pane-acts">
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.cell.assign', 'Assign a terminal to this cell')}
				aria-label={tr('pdmux.cell.assign', 'Assign a terminal to this cell')}
				onclick={(event) => onAssign?.(index, event.currentTarget as HTMLElement)}
				><PlusIcon aria-hidden="true" /></button
			>
			{#if removable}
				<button
					class="pdmux-ico"
					type="button"
					title={tr('pdmux.cell.close', 'Close this cell (the panes after it move forward)')}
					aria-label={tr('pdmux.cell.close', 'Close this cell (the panes after it move forward)')}
					data-pdmux-remove-cell
					onclick={() => onRemove?.(index)}
					><XIcon aria-hidden="true" /></button
				>
			{/if}
		</span>
	</div>
	<button
		class="pdmux-cell-button"
		type="button"
		onclick={(event) => onAssign?.(index, event.currentTarget as HTMLElement)}
		><SquareDashedIcon aria-hidden="true" />
		<span>{tr('pdmux.cell.connect', 'Connect a terminal to this cell')}</span></button
	>
</div>
