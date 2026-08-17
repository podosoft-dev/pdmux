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
	import { type HistoryLine, type HistorySpan, historyFoldable, historyPlain, xterm256 } from '@pdmux/core';
	import { TERMINAL_THEME } from '../adapters/terminal-surface.js';
	import { type Translate, translator } from '../i18n.js';

	let {
		lines = [],
		scrollback = true,
		screenOnly = false,
		pending = false,
		failed = false,
		title = '',
		t,
		onClose,
		onCopy,
	}: {
		/**
		 * The output. A bare string is a line with no attributes — most of them — so a
		 * consumer that has nothing to say about colour keeps passing strings.
		 */
		lines?: readonly HistoryLine[];
		/** False when the pane is on the alternate buffer — one screen, not a history. */
		scrollback?: boolean;
		/**
		 * The MULTIPLEXER has no history for this pane either, because a full-screen program
		 * owns the screen. This is a different sentence from `scrollback: false` and a much less
		 * hopeful one: there is nowhere left to fetch from, so the note has to point at the
		 * program instead of at the multiplexer.
		 */
		screenOnly?: boolean;
		/** A fetch is in flight. Without this, waiting and empty look identical. */
		pending?: boolean;
		/** The fetch was refused or unreachable — say so rather than showing a bare screen. */
		failed?: boolean;
		title?: string;
		t?: Translate;
		onClose?: () => void;
		onCopy?: (text: string) => void;
	} = $props();

	const tr = $derived(translator(t));
	/** What a copy gets: the plain text, never the markup and never the escapes. */
	const text = $derived(historyPlain(lines));

	/**
	 * Which lines are folded right now.
	 *
	 * ⚠ FOLDING HIDES, IT DOES NOT TRUNCATE. The full text stays in the DOM and CSS
	 * clips it, so a selection, a browser find and `textContent` all still see the whole
	 * line. Slicing the string instead would have made the sheet quietly lossy in
	 * exactly the case it was added for — one enormous line nobody can read.
	 */
	let unfolded = $state(new Set<number>());
	const foldable = $derived(lines.map((line) => historyFoldable(line)));

	function toggleFold(index: number): void {
		const next = new Set(unfolded);
		if (!next.delete(index)) next.add(index);
		unfolded = next;
	}

	/** One run's colours, resolved against the palette the terminal beside it paints with. */
	function spanStyle(span: HistorySpan): string {
		// Inverse swaps the two, which is how a selection or a prompt marker is drawn.
		const fg = span.inverse ? span.bg : span.fg;
		const bg = span.inverse ? span.fg : span.bg;
		const parts: string[] = [];
		const fgColor = resolve(fg, span.inverse ? TERMINAL_THEME.background : undefined);
		const bgColor = resolve(bg, span.inverse ? TERMINAL_THEME.foreground : undefined);
		if (fgColor) parts.push(`color:${fgColor}`);
		if (bgColor) parts.push(`background-color:${bgColor}`);
		if (span.bold) parts.push('font-weight:600');
		// Dim is opacity rather than a dimmer colour: it has to work over any background.
		if (span.dim) parts.push('opacity:0.65');
		if (span.italic) parts.push('font-style:italic');
		if (span.underline && span.strike) parts.push('text-decoration:underline line-through');
		else if (span.underline) parts.push('text-decoration:underline');
		else if (span.strike) parts.push('text-decoration:line-through');
		return parts.join(';');
	}

	function resolve(color: HistorySpan['fg'], fallback: string | undefined): string | undefined {
		if (!color) return fallback;
		if (color.kind === 'rgb') return hex(color.value);
		// 0-15 are the product's own palette — the same sixteen the pane is painted with,
		// so the sheet and the terminal cannot disagree about what "red" is.
		const named = PALETTE[color.index];
		return named ?? hex(xterm256(color.index));
	}

	const PALETTE: readonly string[] = [
		TERMINAL_THEME.black,
		TERMINAL_THEME.red,
		TERMINAL_THEME.green,
		TERMINAL_THEME.yellow,
		TERMINAL_THEME.blue,
		TERMINAL_THEME.magenta,
		TERMINAL_THEME.cyan,
		TERMINAL_THEME.white,
		TERMINAL_THEME.brightBlack,
		TERMINAL_THEME.brightRed,
		TERMINAL_THEME.brightGreen,
		TERMINAL_THEME.brightYellow,
		TERMINAL_THEME.brightBlue,
		TERMINAL_THEME.brightMagenta,
		TERMINAL_THEME.brightCyan,
		TERMINAL_THEME.brightWhite,
	];

	const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

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

	<!--
		ONE LINE THAT SAYS WHICH OF FOUR THINGS THE READER IS LOOKING AT, in the order they
		matter. Three of these used to be the same silence: a sheet with one screen in it looked
		exactly like a sheet still fetching and exactly like a sheet whose fetch was refused, and
		the reader's only clue was that what they remembered was not there.
	-->
	{#if pending}
		<p class="pdmux-meta" data-pdmux-history-note="pending">
			{tr('pdmux.history.pending', 'Fetching what the multiplexer holds…')}
		</p>
	{:else if failed}
		<p class="pdmux-meta" data-pdmux-history-note="failed">
			{tr('pdmux.history.failed', 'The host could not be asked for its history — this is the visible screen.')}
		</p>
	{:else if screenOnly}
		<!--
			⚠ THE MULTIPLEXER HAS NOTHING EITHER, so this note may not point at it. A full-screen
			program (a coding agent's TUI, `vim`) draws on the pane's alternate screen and the
			multiplexer keeps history for the normal one — measured on one fleet: `history_size` 48
			behind such a pane against 1991 behind a pane whose program prints normally. The only
			thing that can show earlier output is the program itself, so the note says how.
		-->
		<p class="pdmux-meta" data-pdmux-history-note="screen">
			{tr(
				'pdmux.history.programScreen',
				'A full-screen program owns this pane, so nothing above its screen was kept — scroll the program itself to see earlier output.',
			)}
		</p>
	{:else if !scrollback}
		<!--
			The original note: this process has no scrollback for the pane, but the multiplexer
			does — naming where the history actually lives is what stops the feature reading as
			broken.
		-->
		<p class="pdmux-meta" data-pdmux-history-note="multiplexer">
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
		<!--
			⚠ SPANS AND LITERAL NEWLINES, NEVER ONE BLOCK PER LINE. `textContent` of
			`<div>a</div><div>b</div>` is `ab` — the newlines simply vanish, and with them
			every copy, every browser find and the assertion that this sheet reads as the
			text it was given. Inline runs separated by real `\n` text nodes keep the block
			byte-identical to `lines.join('\n')` while still carrying colour.
		-->
		<pre class="pdmux-history-text">{#each lines as line, index (index)}{#if index > 0}{'\n'}{/if}<span
					class="pdmux-history-line"
					data-pdmux-line={index}
					data-pdmux-folded={foldable[index] && !unfolded.has(index) ? 'true' : undefined}
					>{#if typeof line === 'string'}{line}{:else}{#each line as span, at (at)}<span
								style={spanStyle(span)}>{span.text}</span
							>{/each}{/if}</span
				>{#if foldable[index]}<button
						class="pdmux-history-fold"
						type="button"
						data-pdmux-fold-line={index}
						aria-expanded={unfolded.has(index)}
						title={unfolded.has(index)
							? tr('pdmux.history.foldLine', 'Fold this line')
							: tr('pdmux.history.unfoldLine', 'Show the whole line')}
						aria-label={unfolded.has(index)
							? tr('pdmux.history.foldLine', 'Fold this line')
							: tr('pdmux.history.unfoldLine', 'Show the whole line')}
						onclick={() => toggleFold(index)}
					></button>{/if}{/each}</pre>
	</div>

	<!--
		⚠ "NOTHING HAS BEEN PRINTED YET" IS A CLAIM, AND IT WAS SOMETIMES FALSE. While a fetch is
		in flight, or after one failed, the sheet knows nothing about what the pane printed — and
		saying it printed nothing sent people to another machine to check. The note above owns
		those two cases; this line is only for a pane that really is empty.
	-->
	{#if lines.length === 0 && !pending && !failed}
		<p class="pdmux-meta" data-pdmux-empty="history">{tr('pdmux.history.empty', 'Nothing has been printed yet')}</p>
	{/if}
</div>
