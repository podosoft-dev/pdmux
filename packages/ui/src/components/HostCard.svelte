<script lang="ts">
	/**
	 * One host: what is running on it, what it is using, and where to open it.
	 *
	 * The header carries the name and the settings trigger only. A "busy"/"idle" chip
	 * used to sit here and was dropped: it merely restated the agent count in colour,
	 * and could not tell an agent waiting at a prompt from one doing work. A
	 * stopped/unknown chip stays — without it a card whose every value is a dash looks
	 * broken instead of switched off.
	 *
	 * That chip is now a GLYPH beside the ⚙ rather than a word, because the word was the
	 * widest thing in a narrow column. The requirement it inherits is unchanged: three
	 * states, and never colour alone. `unknown` (disabled — nobody is asking) has to stay
	 * separable from `offline` (asked, no answer), and the state name travels in `title` +
	 * `aria-label` so the card still reads as switched-off rather than broken to anyone
	 * who cannot separate the hues.
	 *
	 * It was an 8px COLOURED DISC first, and that was reported as looking wrong beside the
	 * ⚙: two controls-sized shapes in a row and then a pinhead, saying nothing but its hue.
	 * A disc leans its whole meaning on colour — the label underneath it was the only other
	 * channel, and a label you have to hover for is not a channel you can glance at. A
	 * SHAPE reads at a glance and survives greyscale, so each state is now its own drawing
	 * at the ⚙'s own 16px.
	 */
	import { type AgentRow, type CardPrefs, type HostSeries, type ServiceOption, cardPrefs } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import type { HostResources, HostSummary } from '../types.js';
	import ResourceRow from './ResourceRow.svelte';
	import ServiceLauncher from './ServiceLauncher.svelte';
	import UsageGaugeRow from './UsageGaugeRow.svelte';

	interface Props {
		host: HostSummary;
		agents?: readonly AgentRow[];
		resources?: HostResources;
		history?: HostSeries | null;
		services?: readonly ServiceOption[];
		prefs?: CardPrefs;
		now?: number;
		windowSec?: number;
		windowLabels?: Record<string, string>;
		t?: Translate;
		onOpenService?: (url: string, hostId: string) => void;
		onOpenSettings?: (hostId: string, anchor: HTMLElement) => void;
	}

	let {
		host,
		agents = [],
		resources = {},
		history = null,
		services = [],
		prefs,
		now,
		windowSec = 3600,
		windowLabels = {},
		t,
		onOpenService,
		onOpenSettings,
	}: Props = $props();

	const tr = $derived(translator(t));
	const widgets = $derived(prefs ?? cardPrefs(undefined, host.id));
	const offline = $derived(host.state !== undefined && host.state !== 'online');
	const reach = $derived(host.state ?? 'online');
	/** Always a name, for every state — the dot is never the only thing that says it. */
	const reachLabel = $derived(
		reach === 'offline'
			? tr('pdmux.host.stopped', 'stopped')
			: reach === 'unknown'
				? tr('pdmux.host.unknown', 'unknown')
				: tr('pdmux.host.online', 'online'),
	);
	const rows = $derived([
		{ key: 'cpu' as const, label: 'CPU', pct: resources.cpuPct, hint: '' },
		{ key: 'mem' as const, label: 'MEM', pct: resources.memPct, hint: resources.memHint ?? '' },
		{ key: 'disk' as const, label: 'DISK', pct: resources.diskPct, hint: resources.diskHint ?? '' },
	]);
</script>

<article class="pdmux pdmux-card" data-pdmux-host={host.id} data-pdmux-state={host.state ?? 'online'}>
	<header class="pdmux-card-head">
		<span data-pdmux-name title={host.name}>{host.name}</span>
		<!--
			Reachability, drawn. ONE FAMILY, THREE SILHOUETTES: a chain link that is joined,
			parted, or dashed — which is exactly what the three labels already said in words
			(connected / disconnected / unknown), so the picture and the word agree.

			⚠ THE SHAPE IS THE CHANNEL, the colour is the accent. Whoever cannot separate green
			from red still sees a bar in the middle or a gap where it should be, and `unknown`
			stays its own thing rather than a dimmer `offline` — the point the busy/idle chip
			was dropped for and this one was kept for. Its dash comes from the stylesheet, so
			the path itself stays identical to the joined one: nothing is being reported as
			broken, we are simply not asking.

			Path data is lucide's `link-2` / `unlink-2` (ISC, © Lucide Icons and Contributors).
			Copied rather than imported for the same reason the ⚙ is: this package ships with
			exactly one peer dependency and an icon library is not worth breaking that for.
		-->
		<span
			class="pdmux-state-dot"
			data-pdmux-reach={reach}
			role="img"
			title={reachLabel}
			aria-label={reachLabel}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				{#if reach === 'offline'}
					<path d="M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2" />
				{:else}
					<path d="M9 17H7A5 5 0 0 1 7 7h2" />
					<path d="M15 7h2a5 5 0 1 1 0 10h-2" />
					<path d="M8 12h8" />
				{/if}
			</svg>
		</span>
		<!--
			The gear is drawn, not typed. `⚙` is an emoji-presentation codepoint: the platform
			picks the font, so the same button was a flat glyph here and a colour sticker on a
			phone, at whatever size that font felt like. An inline path is one shape everywhere,
			inherits `currentColor` for the hover and focus states, and costs no dependency —
			this package has exactly one peer (svelte) and an icon library would not be worth
			breaking that for. Geometry (36px, 44px on a coarse pointer) is in the stylesheet.
		-->
		<button
			class="pdmux-cog"
			type="button"
			aria-label={tr('pdmux.card.settings', 'card settings')}
			onclick={(event) => onOpenSettings?.(host.id, event.currentTarget as HTMLElement)}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path
					d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
				/>
				<circle cx="12" cy="12" r="3" />
			</svg>
		</button>
	</header>

	{#if widgets.agents}
		<ul class="pdmux-widget" data-pdmux-widget="agents">
			{#each agents as row (row.provider)}
				<UsageGaugeRow {row} {windowLabels} {t} />
			{/each}
		</ul>
	{/if}

	{#if widgets.resources}
		<ul class="pdmux-widget" data-pdmux-widget="resources">
			{#each rows as row (row.key)}
				<ResourceRow
					label={row.label}
					pct={row.pct}
					samples={history?.[row.key] ?? []}
					{now}
					{windowSec}
					hint={row.hint}
					{t}
				/>
			{/each}
		</ul>
	{/if}

	{#if widgets.links}
		<div data-pdmux-widget="links">
			<ServiceLauncher options={services} disabled={offline} {t} onOpen={(url) => onOpenService?.(url, host.id)} />
		</div>
	{/if}
</article>
