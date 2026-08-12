<script lang="ts">
	/**
	 * One resource line: label, percentage, recent trend.
	 *
	 * Label and value are fixed-width so several rows line up and the graphs start at
	 * the same x; the value uses tabular numerals so it does not jitter as it changes.
	 */
	import { HOT_PCT, type Sample, usageCell } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import MetricSparkline from './MetricSparkline.svelte';

	interface Props {
		/** Short metric label, already localized by the caller (e.g. "CPU"). */
		label: string;
		pct: number | null | undefined;
		samples?: readonly Sample[];
		now?: number;
		windowSec?: number;
		/** Extra detail for the tooltip, e.g. "12Gi/30Gi". */
		hint?: string;
		/**
		 * Where this metric's red band starts. Swap passes `SWAP_HOT_PCT`; the rest
		 * take the default. It reaches BOTH the number and the sparkline, because a
		 * value coloured red against a band it never crossed reads as a rendering bug.
		 */
		hotPct?: number;
		t?: Translate;
	}

	let { label, pct, samples = [], now, windowSec = 3600, hint = '', hotPct = HOT_PCT, t }: Props = $props();

	const tr = $derived(translator(t));
	const cell = $derived(usageCell(pct, hotPct));
	// An unmeasured value is a dash and is NEVER red: "unknown" must not read as
	// "healthy", and must not read as "on fire" either.
	const text = $derived(cell.pct == null ? '—' : `${cell.pct}%`);
	const sparkLabel = $derived(
		tr('pdmux.metric.trend', 'recent trend') + (cell.pct == null ? '' : ` — ${label} ${text}`),
	);
</script>

<!-- `hint` (e.g. "12Gi/30Gi") lives in `title`, which does not exist on a touch screen —
     so it is the accessible name too. The row already shows the percentage; the absolute
     figures are the detail a tooltip was hiding from every phone. -->
<li
	class="pdmux-row"
	data-pdmux-metric={label}
	title={hint}
	aria-label={hint ? `${label} ${text} — ${hint}` : `${label} ${text}`}
>
	<span class="pdmux-metric-label">{label}</span>
	<b class="pdmux-metric-value" class:pdmux-hot={cell.hot} data-pdmux-pct={cell.pct ?? ''}>{text}</b>
	<MetricSparkline {samples} {now} {windowSec} {hotPct} label={sparkLabel} />
</li>
