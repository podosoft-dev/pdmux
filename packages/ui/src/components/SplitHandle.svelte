<script lang="ts">
	/**
	 * A draggable splitter — a column edge by default, a row edge with `axis="y"`.
	 *
	 * ⚠ `setPointerCapture` is mandatory, not a nicety. The moment the pointer enters
	 * an embedded surface (a terminal, or an embedded view) that surface swallows
	 * `pointermove` and a document-level listener stops hearing anything — the drag
	 * silently freezes. Measured: dragging a dock splitter over its own embedded view
	 * left the width stuck. Capture routes every event to the handle until release,
	 * and `pointercancel` must commit like `pointerup` because capture can be revoked.
	 */
	import { type Translate, translator } from '../i18n.js';

	interface Props {
		/** Which way the gesture is measured: `x` for a column edge, `y` for a row edge. */
		axis?: 'x' | 'y';
		/**
		 * Negate the delta when the handle grows its panel against the axis direction —
		 * a right-hand dock (drag left = wider) or a bottom panel (drag up = taller).
		 */
		invert?: boolean;
		label?: string;
		t?: Translate;
		/** Called continuously while dragging, with the signed pixel delta. */
		onDrag?: (delta: number) => void;
		/** Called once on release (or cancel) with the final delta. */
		onCommit?: (delta: number) => void;
	}

	let { axis = 'x', invert = false, label, t, onDrag, onCommit }: Props = $props();

	const tr = $derived(translator(t));
	let dragging = $state(false);

	function start(event: PointerEvent): void {
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		const vertical = axis === 'y';
		const origin = vertical ? event.clientY : event.clientX;
		const sign = invert ? -1 : 1;
		const delta = (ev: PointerEvent): number => ((vertical ? ev.clientY : ev.clientX) - origin) * sign;
		try {
			handle.setPointerCapture(event.pointerId);
		} catch {
			// Capture unsupported: the drag still works over plain areas.
		}
		dragging = true;
		const move = (ev: PointerEvent): void => onDrag?.(delta(ev));
		const end = (ev: PointerEvent): void => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
			try {
				handle.releasePointerCapture(event.pointerId);
			} catch {
				// Already released.
			}
			dragging = false;
			onCommit?.(delta(ev));
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}
</script>

<div
	class="pdmux pdmux-handle"
	role="separator"
	aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
	aria-label={label ?? tr('pdmux.handle.resize', 'resize')}
	data-pdmux-handle
	data-pdmux-axis={axis}
	data-pdmux-edge={invert ? 'trailing' : 'leading'}
	data-dragging={dragging}
	onpointerdown={start}
></div>
