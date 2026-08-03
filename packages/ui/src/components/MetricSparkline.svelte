<script lang="ts">
	/**
	 * One metric's recent trend.
	 *
	 * The red band is the SAME path drawn a second time inside a NESTED <svg> whose
	 * viewport is only the top slice of the box: a nested svg clips to its viewport
	 * and shares the parent's units, so the copy lines up without rescaling. Not
	 * `clipPath`+id on purpose — one id per card per metric is a duplicate-id hazard,
	 * and duplicate ids break rendering silently.
	 */
	import { HOT_PCT, SPARK, type Sample, sparkGeometry } from '@pdmux/core';

	interface Props {
		samples?: readonly Sample[];
		/** Epoch SECONDS of the right edge; defaults to the clock. */
		now?: number;
		/** Drawn window, in seconds. */
		windowSec?: number;
		width?: number;
		height?: number;
		hotPct?: number;
		/** Accessible description; the caller formats it with its own i18n. */
		label?: string;
	}

	let {
		samples = [],
		now,
		windowSec = 3600,
		width = SPARK.w,
		height = SPARK.h,
		hotPct = HOT_PCT,
		label = '',
	}: Props = $props();

	const geometry = $derived(
		sparkGeometry(samples, { now: now ?? Date.now() / 1000, window: windowSec, w: width, h: height, hotPct }),
	);
	// Nothing inside the window yet (a fresh feed, or a host with no samples): draw
	// no box at all rather than an empty one, which reads as broken.
	const hasData = $derived(geometry.line.length > 0);
	// The band is only worth drawing when something actually reaches it — otherwise
	// it is invisible DOM that also makes "is anything red?" unreadable.
	const showBand = $derived(geometry.max !== null && geometry.max >= hotPct);
</script>

{#if hasData}
	<svg
		class="pdmux-spark"
		viewBox="0 0 {width} {height}"
		preserveAspectRatio="none"
		role="img"
		aria-label={label}
		data-pdmux-max={geometry.max}
		data-pdmux-last={geometry.last}
	>
		<title>{label}</title>
		<line class="pdmux-guide" x1="0" x2={width} y1={geometry.hotY} y2={geometry.hotY} />
		{#each geometry.area as d (d)}
			<path class="pdmux-area" {d} />
		{/each}
		{#each geometry.line as d (d)}
			<path class="pdmux-line" {d} />
		{/each}
		{#if showBand}
			<svg
				x="0"
				y="0"
				{width}
				height={geometry.hotY}
				viewBox="0 0 {width} {geometry.hotY}"
				preserveAspectRatio="none"
				overflow="hidden"
			>
				{#each geometry.area as d (d)}
					<path class="pdmux-area pdmux-hot" {d} />
				{/each}
				{#each geometry.line as d (d)}
					<path class="pdmux-line pdmux-hot" {d} />
				{/each}
			</svg>
		{/if}
	</svg>
{/if}
