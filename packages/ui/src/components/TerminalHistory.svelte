<script lang="ts">
	/**
	 * A pane's output, as plain selectable text.
	 *
	 * WHY IT EXISTS: a terminal in a 3x3 grid is a few hundred pixels tall, and anything
	 * that scrolled past it can only be reached by scrubbing a tiny viewport. On a phone it
	 * could not be reached at all until the scroll buttons landed. Here the same bytes are
	 * one scrollable block a finger can flick and a pointer can select.
	 *
	 * ⚠ IT IS NOT ALWAYS A HISTORY, AND THIS COMPONENT SAYS SO OUT LOUD.
	 *
	 * A pane attached to a multiplexer runs it in xterm's ALTERNATE buffer, and xterm keeps
	 * no scrollback for that buffer at all — the history lives inside tmux, not in this
	 * process. Such a pane can only ever hand over its visible screen. Calling that "the
	 * full output" would be a claim the user cannot check and would quietly disbelieve the
	 * first time something they remembered was missing, so `scrollback: false` earns a
	 * visible note rather than silence.
	 */
	import { type Translate, translator } from '../i18n.js';

	let {
		lines = [],
		scrollback = true,
		title = '',
		t,
		onClose,
		onCopy,
	}: {
		lines?: readonly string[];
		/** False when the pane is on the alternate buffer — one screen, not a history. */
		scrollback?: boolean;
		title?: string;
		t?: Translate;
		onClose?: () => void;
		onCopy?: (text: string) => void;
	} = $props();

	const tr = $derived(translator(t));
	const text = $derived(lines.join('\n'));

	function keydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') onClose?.();
	}
</script>

<svelte:window on:keydown={keydown} />

<!--
	A modal sheet rather than a popover: this is a reading surface, it wants the width, and
	the backdrop is what lets a tap anywhere dismiss it on a phone.
-->
<div
	class="pdmux pdmux-history-back"
	data-pdmux-history-back
	role="presentation"
	onclick={() => onClose?.()}
></div>
<div
	class="pdmux pdmux-history"
	data-pdmux-popover="terminal-history"
	data-testid="terminal-history"
	role="dialog"
	aria-modal="true"
	aria-label={tr('pdmux.history.title', 'Terminal output')}
>
	<div class="pdmux-popover-head">
		<span class="pdmux-popover-title">{title || tr('pdmux.history.title', 'Terminal output')}</span>
		<button
			class="pdmux-ico"
			type="button"
			data-testid="terminal-history-copy"
			title={tr('pdmux.history.copy', 'Copy all')}
			aria-label={tr('pdmux.history.copy', 'Copy all')}
			onclick={() => onCopy?.(text)}>⧉</button
		>
		<button
			class="pdmux-ico"
			type="button"
			data-testid="terminal-history-close"
			title={tr('pdmux.history.close', 'Close')}
			aria-label={tr('pdmux.history.close', 'Close')}
			onclick={() => onClose?.()}>✕</button
		>
	</div>

	{#if !scrollback}
		<!--
			The honest note. A pane running a multiplexer has no scrollback in this process at
			all, so this is one screen — and the place its history actually lives is worth
			naming, or the user is left thinking the feature is broken.
		-->
		<p class="pdmux-meta" data-pdmux-history-note>
			{tr(
				'pdmux.history.screenOnly',
				'This pane runs a multiplexer, which keeps its own history — only the visible screen is available here.',
			)}
		</p>
	{/if}

	<!--
		The SCROLLER carries the tabstop, not the `pre`.
		A scrollable region that cannot be focused cannot be scrolled from a keyboard at all,
		which on this sheet means most of the output is unreachable without a pointer. The
		wrapper takes `role="region"` + `tabindex="0"` (the documented pattern for exactly
		this) and the `pre` stays a plain block of text inside it.
	-->
	<!--
		⚠ The rule is wrong for this element, and dropping the tabstop would cost real
		keyboard access. `a11y_no_noninteractive_tabindex` exists to stop stray tabstops on
		decorative markup; a SCROLLABLE region is the documented exception (WAI-ARIA
		Authoring Practices: a scrollable region gets `role="region"`, an accessible name,
		and `tabindex="0"` precisely so it can be reached and scrolled without a pointer).
		Satisfying the linter here would mean most of this pane's output is unreachable
		unless you have a mouse. Suppressed narrowly, on this one element.
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="pdmux-history-body"
		data-pdmux-history-body
		data-pdmux-lines={lines.length}
		role="region"
		aria-label={tr('pdmux.history.body', 'Output')}
		tabindex="0"
	>
		<pre class="pdmux-history-text">{text}</pre>
	</div>

	{#if lines.length === 0}
		<p class="pdmux-meta" data-pdmux-empty="history">{tr('pdmux.history.empty', 'Nothing has been printed yet')}</p>
	{/if}
</div>
