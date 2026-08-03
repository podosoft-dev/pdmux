<script lang="ts">
	/**
	 * The keys a phone keyboard does not have, and the two things a finger cannot do.
	 *
	 * Esc and the arrows are what a shell and a coding agent need constantly, and no
	 * software keyboard offers them. Without this row a phone can type words at a terminal
	 * and nothing else — no completion, no history, no interrupt.
	 *
	 * ⚠ EVERY PRESS IS `pointerdown` + `preventDefault`, NEVER `click`.
	 *
	 * A button that takes focus takes it FROM the terminal's hidden textarea, and both iOS
	 * and Android close the software keyboard the moment the focused element stops being
	 * editable — the row would dismiss the very keyboard it exists to serve. Preventing the
	 * default on pointerdown suppresses the focus change; handling the press there too is
	 * required because a prevented pointerdown may never produce a click on Safari. This
	 * applies to the cycle button and the scroll buttons exactly as it does to the keys.
	 *
	 * ⚠ `⌘` TURNS THE PAGE — IT DOES NOT OPEN ANYTHING.
	 *
	 * The other keys used to live in a POPOVER opened from here, and a popover is a thing on
	 * top of the thing you are aiming at. Reported from a phone as covering the screen; even
	 * shrunk to a single row it still measured 20.7% of the pane, and you still had to close
	 * it to read what you had just typed. So the five key cells CYCLE IN PLACE instead: same
	 * row, same eight controls, nothing ever drawn over the terminal, and the tap count is
	 * unchanged (`⌘` then the key, exactly as before).
	 *
	 * The sets are `@pdmux/core`'s (`HELPER_KEY_SETS`) — which keys, and why five is the
	 * ceiling, is decided there against the width of a 320px row.
	 *
	 * WHAT CHANGED BEFORE THAT: the row used to be `esc tab ctrl ← ↓ ↑ →`. `ctrl` was a
	 * LATCH, and a latch whose state a finger cannot see is a trap. The width that freed went
	 * to scrolling, which a phone had no way to do at all: a mouse has a wheel, a finger had
	 * nothing, so everything above the fold was simply unreachable.
	 */
	import { HELPER_KEY_SETS, type HelperKeyId, type HelperKeySet } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	let {
		sets = HELPER_KEY_SETS,
		ctrl = false,
		/** Hidden when the pane cannot scroll — see `onScroll`. */
		scrollable = true,
		t,
		onKey,
		onScroll,
	}: {
		/** The pages `⌘` turns through. The first one is what the row opens on. */
		sets?: readonly HelperKeySet[];
		/** Whether Ctrl is latched — the caller owns the latch, this only shows it. */
		ctrl?: boolean;
		scrollable?: boolean;
		t?: Translate;
		onKey?: (id: HelperKeyId) => void;
		onScroll?: (direction: -1 | 1) => void;
	} = $props();

	const tr = $derived(translator(t));

	/**
	 * Which page the row is on. Wraps, so `⌘` is never a control that does nothing — the
	 * same rule the scroll buttons are held to. Clamped on read as well, so a shorter set
	 * list cannot strand it.
	 */
	let page = $state(0);
	const set = $derived(sets[page % Math.max(1, sets.length)] ?? sets[0]);
	const keys = $derived(set?.keys ?? []);

	const GLYPH: Partial<Record<HelperKeyId, string>> = {
		esc: 'esc',
		tab: 'tab',
		ctrl: 'ctrl',
		up: '↑',
		down: '↓',
		left: '←',
		right: '→',
		enter: '⏎',
		// ⚠ `pgup`/`pgdn` as WORDS, not ⇞/⇟: those two glyphs are the scroll buttons at the
		// end of this same row, and a key that looks identical to the control beside it but
		// does something else is worse than either alone.
		shiftTab: '⇧⇥',
		backspace: '⌫',
		delete: 'del',
		home: 'home',
		end: 'end',
		pageUp: 'pgup',
		pageDown: 'pgdn',
		ctrlC: '^C',
		ctrlD: '^D',
		ctrlL: '^L',
		ctrlR: '^R',
		ctrlZ: '^Z',
	};

	/** Spoken labels: an arrow glyph alone tells a screen reader nothing useful. */
	const LABEL: Partial<Record<HelperKeyId, string>> = {
		esc: 'Escape',
		tab: 'Tab',
		ctrl: 'Control',
		up: 'Arrow up',
		down: 'Arrow down',
		left: 'Arrow left',
		right: 'Arrow right',
		enter: 'Enter',
		shiftTab: 'Shift Tab',
		backspace: 'Backspace',
		delete: 'Delete',
		home: 'Home',
		end: 'End',
		pageUp: 'Page up',
		pageDown: 'Page down',
		ctrlC: 'Control C',
		ctrlD: 'Control D',
		ctrlL: 'Control L',
		ctrlR: 'Control R',
		ctrlZ: 'Control Z',
	};

	/** Set names, for the cycle button's spoken label — the glyphs carry the visible meaning. */
	const SET_LABEL: Record<string, string> = {
		nav: 'Arrows',
		edit: 'Editing',
		move: 'Movement',
		ctrl: 'Control chords',
	};

	const setName = (id: string | undefined): string =>
		id ? tr(`pdmux.keys.set.${id}`, SET_LABEL[id] ?? id) : '';

	function press(event: PointerEvent, id: HelperKeyId): void {
		event.preventDefault();
		onKey?.(id);
	}

	function hold(event: PointerEvent, run: () => void): void {
		event.preventDefault();
		run();
	}

	function turn(): void {
		page = (page + 1) % Math.max(1, sets.length);
	}
</script>

<div
	class="pdmux pdmux-keys"
	data-pdmux-keys
	data-pdmux-keyset={set?.id}
	data-testid="terminal-keys"
	role="group"
	aria-label={tr('pdmux.keys.label', 'Terminal keys')}
>
	<!--
		The page turn. It is not a key, so it carries no `data-pdmux-key` — nothing may mistake
		it for one and send it. Its spoken label names the set it will bring, because the row's
		own faces are what say which set is showing.
	-->
	<button
		class="pdmux-key pdmux-key-cycle"
		type="button"
		data-pdmux-keyset-next
		data-testid="terminal-keys-cycle"
		aria-label={tr('pdmux.keys.cycle', 'Next keys')}
		tabindex="-1"
		onpointerdown={(event) => hold(event, turn)}>⌘</button
	>

	{#each keys as key (key)}
		<button
			class="pdmux-key"
			type="button"
			data-pdmux-key={key}
			data-testid={`terminal-key-${key}`}
			aria-label={tr(`pdmux.keys.${key}`, LABEL[key] ?? key)}
			aria-pressed={key === 'ctrl' ? ctrl : undefined}
			tabindex="-1"
			onpointerdown={(event) => press(event, key)}>{GLYPH[key] ?? key}</button
		>
	{/each}

	<!--
		Scrolling, which a phone had no other way to do. These do NOT cycle: they are the wheel,
		and a wheel is not one page of a keyboard.
		⚠ Hidden rather than disabled when a wheel would reach nothing here — a control that
		visibly does nothing is worse than no control. The pane decides; this only draws what it
		is told.
	-->
	{#if scrollable}
		<button
			class="pdmux-key"
			type="button"
			data-pdmux-scroll="up"
			data-testid="terminal-scroll-up"
			aria-label={tr('pdmux.keys.scrollUp', 'Scroll up')}
			tabindex="-1"
			onpointerdown={(event) => hold(event, () => onScroll?.(-1))}>⇞</button
		>
		<button
			class="pdmux-key"
			type="button"
			data-pdmux-scroll="down"
			data-testid="terminal-scroll-down"
			aria-label={tr('pdmux.keys.scrollDown', 'Scroll down')}
			tabindex="-1"
			onpointerdown={(event) => hold(event, () => onScroll?.(1))}>⇟</button
		>
	{/if}
</div>

<!--
	The visible name of the page that is showing, for a screen reader only. The glyphs say it
	to a reader with eyes; without this a blind user turns the page and hears nothing change.
-->
<span class="pdmux-sr-only" aria-live="polite" data-testid="terminal-keyset-name">{setName(set?.id)}</span>
