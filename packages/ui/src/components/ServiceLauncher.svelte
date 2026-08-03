<script lang="ts">
	/**
	 * Every URL a host exposes, in one select.
	 *
	 * WHY A SELECT AND NOT BUTTONS: three hard-coded links meant the other dozen
	 * services had to be typed by hand. The list is derived from the registered
	 * services, so anything added upstream appears here without a change.
	 *
	 * Enter opens too: after choosing with the keyboard the select is what has focus,
	 * and demanding a Tab to the button is a trap.
	 */
	import { type ServiceOption, defaultServiceSelection, openTarget } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	interface Props {
		options?: readonly ServiceOption[];
		/** Offline host: every one of its URLs is dead, so the whole control is off. */
		disabled?: boolean;
		value?: string | null;
		t?: Translate;
		onOpen?: (url: string) => void;
	}

	let { options = [], disabled = false, value = null, t, onOpen }: Props = $props();

	const tr = $derived(translator(t));
	// The first live service is preselected, so pressing open immediately hits
	// something that answers.
	let selected = $state<string | null>(null);
	const current = $derived(selected ?? value ?? defaultServiceSelection(options));

	function open(): void {
		const url = openTarget({ disabled, value: current });
		if (url) onOpen?.(url);
	}
</script>

<div class="pdmux-launcher" data-pdmux-launcher>
	<select
		aria-label={tr('pdmux.services.label', 'service')}
		{disabled}
		value={current ?? ''}
		onchange={(event) => (selected = (event.currentTarget as HTMLSelectElement).value)}
		onkeydown={(event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				open();
			}
		}}
	>
		{#each options as option (option.id)}
			<option value={option.url} data-pdmux-status={option.status}>{option.text}</option>
		{/each}
	</select>
	<button type="button" {disabled} onclick={open}>{tr('pdmux.services.open', 'Open')}</button>
</div>
