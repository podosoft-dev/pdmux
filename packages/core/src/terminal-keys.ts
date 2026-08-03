/**
 * Which keystrokes a terminal must answer itself.
 *
 * WHY THIS EXISTS: copying a selection out of a web terminal is usually left to the
 * browser's own copy handling. That is unreliable in exactly the situation a
 * dashboard creates — the keystroke can land on the surrounding page rather than
 * the terminal, and the copy quietly does nothing. It was measured on the tool this
 * product generalises: `Ctrl+Insert` copied, `Cmd+C` and `Ctrl+Shift+C` did not, and
 * the user reported "copy stopped working" without any code having changed.
 *
 * So the terminal claims the copy shortcuts. Two rules keep that from breaking
 * anything else:
 *   - a shortcut is only claimed when text is actually selected;
 *   - **Ctrl+C is never claimed.** It interrupts the foreground process, and a
 *     terminal that copies instead of interrupting is a broken terminal.
 *
 * Framework-free and pure so it can be tested without a browser.
 */

/** A keyboard event, narrowed to the fields this decision needs. */
export interface TerminalKeyEvent {
	type?: string;
	key?: string;
	code?: string;
	keyCode?: number;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
}

export type TerminalKeyAction = 'copy' | 'newline' | 'pass';

/**
 * The copy shortcuts. `Cmd+C` on macOS, and the two combinations terminals
 * conventionally use elsewhere.
 */
export function isCopyCombo(event: TerminalKeyEvent): boolean {
	if (event.altKey) return false; // Alt combinations belong to the shell
	if ((event.key === 'Insert' || event.code === 'Insert') && event.ctrlKey && !event.metaKey) return true;
	const isC = event.key === 'c' || event.key === 'C' || event.code === 'KeyC';
	if (!isC) return false;
	if (event.metaKey && !event.ctrlKey) return true;
	if (event.ctrlKey && event.shiftKey) return true;
	return false;
}

/**
 * `Shift+Enter` is a newline, not a submit.
 *
 * A terminal cannot encode it differently from Enter (both are a bare CR on the
 * wire) unless the client maps it, so agent prompts read a plain Enter as "send".
 */
export function isNewlineCombo(event: TerminalKeyEvent): boolean {
	const enter = event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13;
	if (!enter || !event.shiftKey) return false;
	return !(event.ctrlKey || event.altKey || event.metaKey);
}

/** What the terminal should do with a key event. Everything unclaimed is `pass`. */
export function terminalKeyAction(event: TerminalKeyEvent | null | undefined): TerminalKeyAction {
	if (!event || (event.type && event.type !== 'keydown')) return 'pass';
	if (isNewlineCombo(event)) return 'newline';
	return isCopyCombo(event) ? 'copy' : 'pass';
}

/** The byte a newline is sent as — the same one Ctrl+J produces. */
export const TERMINAL_NEWLINE = '\n';

/* ---------------------------------------------------------------------------
 * The soft-keyboard helper row
 *
 * A phone keyboard has no Esc, no Tab, no Ctrl and no arrows — the four things a shell
 * or a coding agent needs most. The bar that supplies them sends BYTES rather than
 * synthetic keyboard events: a synthetic event would have to be encoded by the
 * terminal, and iOS does not reliably deliver `keydown` for soft keys at all (they
 * arrive through the textarea's input path). Bytes are what the far end reads anyway.
 * ------------------------------------------------------------------------- */

export type HelperKeyId =
	| 'esc'
	| 'tab'
	| 'ctrl'
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'enter'
	// Everything below reaches the terminal through the special-key panel rather than the
	// row, because a phone has room for about five controls and a terminal needs forty.
	| 'shiftTab'
	| 'home'
	| 'end'
	| 'pageUp'
	| 'pageDown'
	| 'delete'
	| 'backspace'
	| 'f1'
	| 'f2'
	| 'f3'
	| 'f4'
	| 'f5'
	| 'f6'
	| 'f7'
	| 'f8'
	| 'f9'
	| 'f10'
	| 'f11'
	| 'f12'
	| 'ctrlA'
	| 'ctrlC'
	| 'ctrlD'
	| 'ctrlE'
	| 'ctrlK'
	| 'ctrlL'
	| 'ctrlR'
	| 'ctrlU'
	| 'ctrlW'
	| 'ctrlZ';

/**
 * The keys the helper row shows first, in display order.
 *
 * ⚠ DELIBERATELY SHORT. This row shares the bottom of a phone with the composer, and every
 * control on it costs width the four arrows need. `esc` stays because interrupting an agent
 * is the most common single tap there is.
 *
 * The row also carries controls that are NOT keys — the set-cycle button and the two scroll
 * buttons — and those are the component's business, not this table's.
 */
export const HELPER_KEYS: readonly HelperKeyId[] = ['esc', 'left', 'down', 'up', 'right'];

/**
 * One page of the helper row.
 *
 * ⚠ A SET IS THE ROW ITSELF, NOT A PANEL. The row cycles through these in place — the
 * five key cells between the cycle button and the two scroll buttons change, and nothing
 * is ever drawn over the terminal.
 */
export interface HelperKeySet {
	/** i18n key suffix under `pdmux.keys.set.*`. */
	id: string;
	keys: readonly HelperKeyId[];
}

/**
 * Every key a phone can reach, as the pages the row turns through.
 *
 * THE HISTORY, BECAUSE IT IS THE ARGUMENT. These keys lived in a POPOVER opened from the
 * row, which drew all of them stacked — 32 buttons — over a terminal a few hundred pixels
 * tall. Reported from a phone as covering the screen. Shrinking it to one row with ▲/▼
 * helped (measured: 20.7% of the pane instead of most of it) but did not fix the shape of
 * the problem: a popover is still something on top of the thing you are aiming at, and you
 * still had to close it to read what you had just done.
 *
 * So there is no popover. The row IS the panel, and `⌘` turns the page. That costs ZERO
 * screen — the row was always there — and the tap count did not get worse: reaching `tab`
 * used to be `⌘` then the key, and it still is.
 *
 * ⚠ FIVE IS THE CEILING FOR A SET, and it is measured, not chosen. The row is
 * `1 + set + 2` cells wide; at the narrowest supported width (320px) eight cells come out
 * at 32px each. A sixth key in a set makes nine, and every cell on the row gets narrower —
 * including the arrows, which are the ones a finger hits most.
 *
 * ⚠ `esc` IS ONLY ON THE FIRST SET on purpose. Interrupting an agent is the most common
 * single tap there is, so it must never be behind a page turn; and repeating it on every
 * set would spend a cell that a set of five cannot spare.
 *
 * WHAT IS NOT HERE: `ctrlA`/`ctrlE`/`ctrlK`/`ctrlU`/`ctrlW` and F1–F12. Their bytes stay in
 * `PLAIN` below — that table is xterm's own encoding (the SS3/CSI split, the gaps at 16, 22
 * and 25) rather than a guess, it is pinned by its own tests, and `pressHelperKey` is a
 * public entry point a consumer can still call. What this table decides is what a THUMB
 * reaches, and that is a question about a 320px row.
 */
export const HELPER_KEY_SETS: readonly HelperKeySet[] = [
	{ id: 'nav', keys: HELPER_KEYS },
	{ id: 'edit', keys: ['shiftTab', 'tab', 'enter', 'backspace', 'delete'] },
	{ id: 'move', keys: ['home', 'end', 'pageUp', 'pageDown'] },
	{ id: 'ctrl', keys: ['ctrlC', 'ctrlD', 'ctrlZ', 'ctrlL', 'ctrlR'] },
];

/**
 * Normal cursor mode (`ESC [ A`), not application mode (`ESC O A`).
 *
 * A sender that bypasses the terminal's encoder cannot know whether the far end has
 * DECCKM set, and readline, vim and tmux all accept the normal form — while the
 * application form is misread by a plain shell.
 */
const PLAIN: Record<Exclude<HelperKeyId, 'ctrl'>, string> = {
	esc: '\u001b',
	tab: '\t',
	enter: '\r',
	up: '\u001b[A',
	down: '\u001b[B',
	right: '\u001b[C',
	left: '\u001b[D',

	/*
	 * Shift+Tab — `CSI Z`, "cursor backward tabulation".
	 *
	 * There is no shift modifier in this model and there should not be one: a latch a finger
	 * cannot see the state of is how the ctrl latch went wrong. Shift+Tab is not a modifier
	 * applied to Tab on the wire anyway — it is its own sequence — so it is its own key here.
	 * It is also the key this panel was asked for: coding agents cycle their modes with it
	 * and no phone keyboard can produce it.
	 */
	shiftTab: '\u001b[Z',

	// `CSI H` / `CSI F` rather than the `CSI 1~` / `CSI 4~` form: this is what xterm sends by
	// default and what readline, vim and tmux all accept.
	home: '\u001b[H',
	end: '\u001b[F',
	pageUp: '\u001b[5~',
	pageDown: '\u001b[6~',
	delete: '\u001b[3~',
	// DEL (0x7f), not BS (0x08) — every Unix terminal has meant DEL by Backspace since
	// termios, and sending BS makes readline delete forward instead.
	backspace: '\u007f',

	// F1–F4 are SS3-encoded and F5 up are CSI-encoded, with the famous gaps at 16, 22 and 25.
	// This is xterm's table, not a guess.
	f1: '\u001bOP',
	f2: '\u001bOQ',
	f3: '\u001bOR',
	f4: '\u001bOS',
	f5: '\u001b[15~',
	f6: '\u001b[17~',
	f7: '\u001b[18~',
	f8: '\u001b[19~',
	f9: '\u001b[20~',
	f10: '\u001b[21~',
	f11: '\u001b[23~',
	f12: '\u001b[24~',

	/*
	 * The ctrl chords, as the single control byte each one IS.
	 *
	 * Sent whole rather than by arming the latch and hoping a letter follows: the panel is a
	 * list of complete actions, and a "Ctrl+C" that only half-happens when the next tap goes
	 * astray is worse than no button at all. `ctrlChord()` below still serves the typed path,
	 * where the character genuinely does arrive separately.
	 */
	ctrlA: '\u0001',
	ctrlC: '\u0003',
	ctrlD: '\u0004',
	ctrlE: '\u0005',
	ctrlK: '\u000b',
	ctrlL: '\u000c',
	ctrlR: '\u0012',
	ctrlU: '\u0015',
	ctrlW: '\u0017',
	ctrlZ: '\u001a',
};

/** Ctrl+arrow, the modifier form every modern terminal understands. */
const CTRL_ARROW: Record<'up' | 'down' | 'left' | 'right', string> = {
	up: '\u001b[1;5A',
	down: '\u001b[1;5B',
	right: '\u001b[1;5C',
	left: '\u001b[1;5D',
};

/** Whether the Ctrl key is currently latched. */
export interface HelperState {
	ctrl: boolean;
}

/** What one press produces, and the state that follows it. */
export interface HelperPress {
	data: string;
	state: HelperState;
}

/**
 * One press of the helper row.
 *
 * `ctrl` LATCHES rather than being held: a finger cannot hold one key while pressing
 * another. The latch is spent by the next key, so `Ctrl` then `C` is Ctrl+C, and a second
 * press of `Ctrl` cancels it — otherwise a mis-tap silently arms the next character.
 */
export function pressHelperKey(state: HelperState, id: HelperKeyId): HelperPress {
	const ctrl = state?.ctrl === true;
	if (id === 'ctrl') return { data: '', state: { ctrl: !ctrl } };
	if (ctrl && (id === 'up' || id === 'down' || id === 'left' || id === 'right')) {
		return { data: CTRL_ARROW[id], state: { ctrl: false } };
	}
	if (ctrl && id === 'esc') return { data: PLAIN.esc, state: { ctrl: false } };
	if (ctrl && id === 'enter') return { data: '\n', state: { ctrl: false } }; // Ctrl+Enter = LF
	if (ctrl && id === 'tab') return { data: PLAIN.tab, state: { ctrl: false } };
	return { data: PLAIN[id], state: { ctrl } };
}

/**
 * The control byte a latched Ctrl makes with the next typed character.
 *
 * WHY AT THE DATA LEVEL: a Ctrl latch is worth nothing unless the character after it can
 * come from the SOFT keyboard, and those keys do not arrive as `keydown` on iOS. They do
 * all reach the terminal's data callback, so that is where the latch is spent.
 *
 * `null` for anything that is not exactly one chordable character — a paste, an escape
 * sequence, an emoji. The latch is spent either way; inventing a byte for a paste would
 * corrupt it.
 */
export function ctrlChord(data: string): string | null {
	if (typeof data !== 'string' || [...data].length !== 1) return null;
	const code = data.codePointAt(0) ?? 0;
	// a-z / A-Z -> 0x01..0x1a
	if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
	if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40);
	// The printable chords: @[\]^_ -> 0x00..0x1f, ? -> DEL, space -> NUL
	if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
	if (data === '?') return '\u007f';
	if (data === ' ') return '\u0000';
	return null;
}
