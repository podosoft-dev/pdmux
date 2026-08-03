<script lang="ts">
	/**
	 * An empty grid cell.
	 *
	 * It wears the SAME header as a filled pane so the grid reads consistently, and
	 * because closing a terminal must leave a first-class place you can fill, close or
	 * drag onto — not a gap.
	 *
	 * The close button is two-stage by cell kind: a HOLE (a cell inside the array) has
	 * following panes to pull forward, PADDING (drawn past the end to fill the window)
	 * has nothing, so its button is disabled rather than dead.
	 */
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
		<span class="pdmux-pane-label">#{index + 1} {tr('pdmux.cell.empty', 'empty')}</span>
		<span class="pdmux-pane-acts">
			<button
				class="pdmux-ico"
				type="button"
				title={tr('pdmux.cell.assign', 'Assign a terminal to this cell')}
				aria-label={tr('pdmux.cell.assign', 'Assign a terminal to this cell')}
				onclick={(event) => onAssign?.(index, event.currentTarget as HTMLElement)}>▾</button
			>
			<button
				class="pdmux-ico"
				type="button"
				disabled={!removable}
				title={removable
					? tr('pdmux.cell.close', 'Close this cell (the panes after it move forward)')
					: tr('pdmux.cell.nothingToPull', 'No pane after this cell')}
				onclick={() => removable && onRemove?.(index)}>✕</button
			>
		</span>
	</div>
	<button
		class="pdmux-cell-button"
		type="button"
		onclick={(event) => onAssign?.(index, event.currentTarget as HTMLElement)}
		>＋ {tr('pdmux.cell.terminal', 'terminal')}</button
	>
</div>
