<script lang="ts">
	/**
	 * A real input field to compose in, for phones.
	 *
	 * WHY THIS EXISTS: a terminal takes keystrokes through a hidden textarea, and a mobile
	 * IME is not reliable in one. Reported from a phone: a Korean syllable arrived as its
	 * three separate letters — the platform delivered each one as finished text, so every
	 * intermediate state reached the PTY. Suppressing those events helps where the browser
	 * marks them as composing, but it cannot help where the browser does not say so at all,
	 * and no amount of guessing at event shapes makes a hidden textarea a good IME target.
	 *
	 * So composing happens where the platform is designed to do it: a plain single-line
	 * input, with candidates, jamo assembly and correction all handled natively. The
	 * finished line is sent when the user submits it — which is also how every mobile
	 * terminal app that supports CJK works.
	 *
	 * ASCII typing straight into the terminal still works and is untouched; this is the
	 * path for text the IME has to build first.
	 */
	import { type Translate, translator } from '../i18n.js';

	let {
		t,
		onSubmit,
	}: {
		t?: Translate;
		/** The finished line. The caller decides whether to append a carriage return. */
		onSubmit?: (text: string, submit: boolean) => void;
	} = $props();

	const tr = $derived(translator(t));
	let value = $state('');
	/** True between compositionstart and compositionend — Enter belongs to the IME then. */
	let composing = $state(false);

	function send(submit: boolean): void {
		const text = value;
		if (!text) return;
		value = '';
		onSubmit?.(text, submit);
	}

	function keydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		/**
		 * ⚠ An Enter that ends a composition is the IME's, not ours.
		 *
		 * On a Korean or Japanese keyboard the first Enter commits the candidate; taking it
		 * as "send" would post half a word and leave the rest behind. `isComposing` covers
		 * the browsers that report it and the flag covers the rest.
		 */
		if (composing || event.isComposing) return;
		event.preventDefault();
		send(true);
	}
</script>

<div class="pdmux pdmux-composer" data-pdmux-composer data-testid="terminal-composer">
	<!-- A form so the software keyboard shows a Send key and submits with it. -->
	<form
		class="pdmux-composer-form"
		onsubmit={(event) => {
			event.preventDefault();
			send(true);
		}}
	>
		<input
			class="pdmux-composer-input"
			data-testid="terminal-composer-input"
			type="text"
			bind:value
			placeholder={tr('pdmux.composer.placeholder', 'Type here, then send')}
			aria-label={tr('pdmux.composer.label', 'Terminal input line')}
			enterkeyhint="send"
			inputmode="text"
			autocapitalize="off"
			autocorrect="off"
			autocomplete="off"
			spellcheck="false"
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
			onkeydown={keydown}
		/>
		<!-- Sends WITHOUT a newline, for answering a prompt that reads one key or for
		     building a command up in pieces. -->
		<button
			class="pdmux-composer-put"
			type="button"
			data-testid="terminal-composer-put"
			aria-label={tr('pdmux.composer.put', 'Send without newline')}
			tabindex="-1"
			onpointerdown={(event) => {
				event.preventDefault();
				send(false);
			}}>↦</button
		>
		<button class="pdmux-composer-send" type="submit" data-testid="terminal-composer-send"
			>{tr('pdmux.composer.send', 'Send')}</button
		>
	</form>
</div>
