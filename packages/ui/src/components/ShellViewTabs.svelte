<script lang="ts">
	/**
	 * The bottom bar a phone navigates the shell with.
	 *
	 * WHY IT EXISTS: the desktop shell puts the fleet, the terminals and the commit graph
	 * side by side, which needs about 1000px. Below that they were stacked, and the result
	 * was measured at 390px: cards 320px tall, terminals **0px**, dock 523px. Three things
	 * competing for one screen means at least one of them is useless. So a phone shows one
	 * region at a time and this bar is how you choose — each region then gets the whole
	 * viewport, which is also the only way a terminal is worth typing into.
	 *
	 * It is deliberately dumb: the parent owns which view is active and what happens on a
	 * tap (including the browser-history entry that makes Android's Back button return to
	 * the previous tab instead of leaving the app).
	 */
	import { type Translate, translator } from '../i18n.js';

	/** One destination. `icon` is a short glyph — the label carries the meaning. */
	export interface ShellViewTab {
		id: string;
		/** Already-translated label, or a key the parent's `t` resolves. */
		label: string;
		icon?: string;
		/** Extra context for assistive tech, e.g. "3 terminals". */
		hint?: string;
	}

	let {
		tabs = [],
		active = null,
		t,
		onSelect,
	}: {
		tabs?: readonly ShellViewTab[];
		/** The view on screen, or null when the shell is showing something else. */
		active?: string | null;
		t?: Translate;
		onSelect?: (id: string) => void;
	} = $props();

	const tr = $derived(translator(t));
</script>

<!-- `nav`, not a div: it is the primary navigation of the whole app on this screen. -->
<nav
	class="pdmux pdmux-tabs"
	data-pdmux-region="tabs"
	data-testid="shell-tabs"
	aria-label={tr('pdmux.tabs.label', 'Views')}
>
	{#each tabs as tab (tab.id)}
		<button
			class="pdmux-tab"
			type="button"
			data-pdmux-tab={tab.id}
			data-testid={`shell-tab-${tab.id}`}
			aria-current={active === tab.id ? 'page' : undefined}
			aria-label={tab.hint ? `${tab.label} — ${tab.hint}` : tab.label}
			onclick={() => onSelect?.(tab.id)}
		>
			{#if tab.icon}<span class="pdmux-tab-icon" aria-hidden="true">{tab.icon}</span>{/if}
			<span class="pdmux-tab-label">{tab.label}</span>
		</button>
	{/each}
</nav>
