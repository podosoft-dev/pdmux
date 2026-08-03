<script lang="ts">
	/**
	 * One coding agent: process count and its remaining-budget gauges.
	 *
	 * A window the provider does not report is ABSENT, not an empty gauge — one agent
	 * exposes a weekly limit and no session one, so an empty session gauge on its row
	 * promised data that would never arrive. When nothing at all is reported the row
	 * says so instead of drawing an empty promise.
	 */
	import { type AgentRow, GAUGE, providerLabel } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	interface Props {
		row: AgentRow;
		/** Optional short label per window key, e.g. `{ session: '5h', weekly: '7d' }`. */
		windowLabels?: Record<string, string>;
		t?: Translate;
	}

	let { row, windowLabels = {}, t }: Props = $props();

	const tr = $derived(translator(t));
	const label = (key: string, fallback: string | null): string => windowLabels[key] ?? fallback ?? key;
	/**
	 * The provider as a person reads it, not as the wire spells it.
	 *
	 * `row.provider` is a lowercase id — it keys `data-pdmux-agent`, the fleet setting and
	 * the protocol, and it stays exactly as it is. This is only the name on the card, so a
	 * product called Claude stops appearing as "claude". Routed through `t()` like every
	 * other string here, with the core's table as the fallback, so a consumer can spell a
	 * provider its own way without patching the package.
	 */
	const name = $derived(tr(`pdmux.usage.provider.${row.provider}`, providerLabel(row.provider)));
	const rowTitle = $derived(
		row.age.known
			? `${name} — ${tr('pdmux.usage.age', 'snapshot age')}: ${row.age.value} ${row.age.unit}`
			: name,
	);
</script>

<li
	class="pdmux-row"
	class:pdmux-stale={row.age.stale}
	data-pdmux-agent={row.provider}
	data-pdmux-ts={row.ts ?? ''}
	title={rowTitle}
>
	<span class="pdmux-agent-label">{name}</span>
	<b class="pdmux-agent-count" data-pdmux-count={row.processes}>{row.processes}</b>
	{#if row.windows.length}
		{#each row.windows as w (w.key)}
			<!-- The percentages exist ONLY in this tooltip, which a finger cannot open, so the
			     same text is the accessible name. -->
			<span
				class="pdmux-gauge-wrap"
				data-pdmux-window={w.key}
				title="{label(w.key, w.label)} — {w.usedPct}% {tr('pdmux.usage.used', 'used')} · {w.remainingPct}% {tr(
					'pdmux.usage.left',
					'left',
				)}"
				aria-label="{label(w.key, w.label)} — {w.usedPct}% {tr('pdmux.usage.used', 'used')} · {w.remainingPct}% {tr(
					'pdmux.usage.left',
					'left',
				)}"
			>
				<span class="pdmux-meta">{label(w.key, w.label)}</span>
				<svg class="pdmux-gauge" viewBox="0 0 {GAUGE.w} {GAUGE.h}" preserveAspectRatio="none" aria-hidden="true">
					<rect class="pdmux-track" x="0" y="0" width={GAUGE.w} height={GAUGE.h}></rect>
					<rect
						class="pdmux-fill"
						class:pdmux-low={w.low}
						x="0"
						y="0"
						width={w.width.toFixed(2)}
						height={GAUGE.h}
						data-pdmux-pct={w.pct}
					></rect>
				</svg>
				<b class="pdmux-metric-value" class:pdmux-low={w.low}>{w.pct}%</b>
			</span>
		{/each}
	{:else}
		<span class="pdmux-meta" data-pdmux-empty="usage">{tr('pdmux.usage.none', 'no budget reported')}</span>
	{/if}
</li>
