/**
 * Copy is a feature, not a browser default.
 *
 * The tool this product generalises relied on the browser's copy handling reaching
 * the terminal. Measured there: `Ctrl+Insert` copied, `Cmd+C` and `Ctrl+Shift+C`
 * did nothing, and inside a dashboard the keystroke can land on the surrounding
 * page instead of the terminal — reported by a user as "copy stopped working".
 */
import { describe, expect, it } from 'vitest';
import {
	HELPER_KEYS,
	HELPER_KEY_SETS,
	TERMINAL_NEWLINE,
	ctrlChord,
	isCopyCombo,
	isNewlineCombo,
	pressHelperKey,
	terminalKeyAction,
} from '../src/terminal-keys.js';

const down = (over: Record<string, unknown>): Record<string, unknown> => ({ type: 'keydown', ...over });

describe('[TC-PDCORE-080] the terminal claims the copy shortcuts', () => {
	it('[TC-PDCORE-080] recognises Cmd+C, Ctrl+Shift+C and Ctrl+Insert, by key or code', () => {
		expect(terminalKeyAction(down({ key: 'c', metaKey: true }))).toBe('copy');
		expect(terminalKeyAction(down({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe('copy');
		expect(terminalKeyAction(down({ key: 'Insert', ctrlKey: true }))).toBe('copy');
		expect(terminalKeyAction(down({ code: 'KeyC', metaKey: true }))).toBe('copy');
	});

	it('[TC-PDCORE-080] never claims Ctrl+C — that has to stay an interrupt', () => {
		// A terminal that copies instead of interrupting is a broken terminal.
		expect(terminalKeyAction(down({ key: 'c', ctrlKey: true }))).toBe('pass');
		expect(isCopyCombo({ key: 'c', ctrlKey: true })).toBe(false);
	});

	it('[TC-PDCORE-080] leaves everything else alone', () => {
		expect(terminalKeyAction(down({ key: 'v', metaKey: true }))).toBe('pass');
		expect(terminalKeyAction(down({ key: 'c' }))).toBe('pass');
		expect(terminalKeyAction(down({ key: 'c', metaKey: true, altKey: true }))).toBe('pass');
		expect(terminalKeyAction(down({ key: 'Insert' }))).toBe('pass');
		expect(terminalKeyAction({ type: 'keyup', key: 'c', metaKey: true })).toBe('pass');
		expect(terminalKeyAction(null)).toBe('pass');
		expect(terminalKeyAction(undefined)).toBe('pass');
	});
});

describe('[TC-PDCORE-081] Shift+Enter is a newline, Enter still submits', () => {
	it('[TC-PDCORE-081] claims only a plain Shift+Enter', () => {
		expect(terminalKeyAction(down({ key: 'Enter', shiftKey: true }))).toBe('newline');
		expect(terminalKeyAction(down({ code: 'Enter', shiftKey: true }))).toBe('newline');
		expect(terminalKeyAction(down({ keyCode: 13, shiftKey: true }))).toBe('newline');
		expect(terminalKeyAction(down({ key: 'Enter' }))).toBe('pass');
		for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
			expect(terminalKeyAction(down({ key: 'Enter', shiftKey: true, [mod]: true }))).toBe('pass');
		}
		expect(isNewlineCombo({ key: 'a', shiftKey: true })).toBe(false);
	});

	it('[TC-PDCORE-081] sends LF, the byte Ctrl+J produces in every terminal', () => {
		expect(TERMINAL_NEWLINE).toBe('\n');
	});
});

describe('[TC-PDCORE-084] the helper row sends the keys a phone keyboard does not have', () => {
	it('emits the conventional bytes', () => {
		const idle = { ctrl: false };
		expect(pressHelperKey(idle, 'esc').data).toBe('\u001b');
		expect(pressHelperKey(idle, 'tab').data).toBe('\t');
		expect(pressHelperKey(idle, 'enter').data).toBe('\r');
		// Normal cursor mode, not application mode: the sender cannot know whether the far
		// end set DECCKM, and a plain shell misreads the application form.
		expect(pressHelperKey(idle, 'up').data).toBe('\u001b[A');
		expect(pressHelperKey(idle, 'down').data).toBe('\u001b[B');
		expect(pressHelperKey(idle, 'right').data).toBe('\u001b[C');
		expect(pressHelperKey(idle, 'left').data).toBe('\u001b[D');
	});

	it('latches ctrl, because a finger cannot hold one key while pressing another', () => {
		const armed = pressHelperKey({ ctrl: false }, 'ctrl');
		expect(armed).toEqual({ data: '', state: { ctrl: true } });
		// A second press cancels it — otherwise a mis-tap silently arms the next character.
		expect(pressHelperKey(armed.state, 'ctrl').state.ctrl).toBe(false);

		// Ctrl+arrow is the modifier form every modern terminal understands…
		const ctrlUp = pressHelperKey({ ctrl: true }, 'up');
		expect(ctrlUp.data).toBe('\u001b[1;5A');
		// …and the latch is spent, so the key after it is plain again.
		expect(ctrlUp.state.ctrl).toBe(false);
		expect(pressHelperKey({ ctrl: true }, 'enter').data).toBe('\n');
	});

	it('chords a latched ctrl with the next typed character', () => {
		// The latch is spent at the DATA level because soft keys do not arrive as keydown
		// on iOS — they only reach the terminal's data callback.
		expect(ctrlChord('c')).toBe('\u0003');
		expect(ctrlChord('C')).toBe('\u0003');
		expect(ctrlChord('d')).toBe('\u0004');
		expect(ctrlChord('[')).toBe('\u001b');
		expect(ctrlChord('?')).toBe('\u007f');
		expect(ctrlChord(' ')).toBe('\u0000');

		// Not one chordable character: inventing a byte here would corrupt a paste.
		expect(ctrlChord('git status')).toBeNull();
		expect(ctrlChord('')).toBeNull();
		expect(ctrlChord('🙂')).toBeNull();
		expect(ctrlChord('\u001b[A')).toBeNull();
	});
});

describe('[TC-PDCORE-089] the special-key table covers what a phone keyboard cannot type', () => {
	it('sends Shift+Tab as its own sequence, not a modified Tab', () => {
		// The key this panel was asked for: coding agents cycle their modes with it and no
		// software keyboard can produce it. On the wire it is CSI Z — its own sequence, not
		// Tab with a shift bit — which is why it needs no shift modifier in this model.
		expect(pressHelperKey({ ctrl: false }, 'shiftTab').data).toBe('\u001b[Z');
		expect(pressHelperKey({ ctrl: false }, 'tab').data).toBe('\t');
	});

	it('sends each ctrl chord as one complete control byte', () => {
		// Whole, not by arming a latch and hoping a letter follows: a Ctrl+C that only
		// half-happens when the next tap goes astray is worse than no button.
		expect(pressHelperKey({ ctrl: false }, 'ctrlC').data).toBe('\u0003');
		expect(pressHelperKey({ ctrl: false }, 'ctrlD').data).toBe('\u0004');
		expect(pressHelperKey({ ctrl: false }, 'ctrlZ').data).toBe('\u001a');
		expect(pressHelperKey({ ctrl: false }, 'ctrlL').data).toBe('\u000c');
	});

	it('uses DEL for Backspace, as every Unix terminal has since termios', () => {
		// Sending BS (0x08) instead makes readline delete forward.
		expect(pressHelperKey({ ctrl: false }, 'backspace').data).toBe('\u007f');
	});

	it('encodes the function keys the way xterm does, gaps included', () => {
		// F1–F4 are SS3 and F5 up are CSI, with the famous gaps at 16, 22 and 25.
		expect(pressHelperKey({ ctrl: false }, 'f1').data).toBe('\u001bOP');
		expect(pressHelperKey({ ctrl: false }, 'f5').data).toBe('\u001b[15~');
		expect(pressHelperKey({ ctrl: false }, 'f6').data).toBe('\u001b[17~');
		expect(pressHelperKey({ ctrl: false }, 'f12').data).toBe('\u001b[24~');
	});

	it('gives every advertised key a sequence, and never an empty one', () => {
		// A button that sends nothing is indistinguishable from a broken one. `ctrl` is the
		// only id allowed to send nothing, and the row deliberately does not offer it.
		for (const set of HELPER_KEY_SETS) {
			for (const key of set.keys) {
				expect(key, `${key} is the latch, which the row must not offer`).not.toBe('ctrl');
				expect(pressHelperKey({ ctrl: false }, key).data, `${key} sends nothing`).not.toBe('');
			}
		}
	});

	it('keeps every set short enough for the row it has to fit', () => {
		/**
		 * ⚠ FIVE IS MEASURED, NOT CHOSEN. The row is `1 + set + 2` cells wide — a page-turn
		 * button, the set, and the two scroll buttons — and at the narrowest supported width
		 * (320px) eight cells come out at 32px each. A sixth key in any set makes nine, and
		 * every cell on the row narrows with it, including the arrows a finger hits most.
		 */
		for (const set of HELPER_KEY_SETS) {
			expect(set.keys.length, `the ${set.id} set does not fit the row`).toBeLessThanOrEqual(5);
			expect(set.keys.length, `the ${set.id} set is empty`).toBeGreaterThan(0);
		}
		// Ids are what the i18n keys and the `data-pdmux-keyset` attribute are built from.
		expect(new Set(HELPER_KEY_SETS.map((set) => set.id)).size).toBe(HELPER_KEY_SETS.length);
	});

	it('opens on the arrows, and never buries esc behind a page turn', () => {
		// Interrupting an agent is the most common single tap there is, so `esc` may not be
		// one page turn away; the arrows are what a shell needs constantly.
		expect(HELPER_KEY_SETS[0]?.keys).toEqual(HELPER_KEYS);
		expect(HELPER_KEYS.length).toBeLessThanOrEqual(5);
		expect(HELPER_KEYS).toContain('esc');
		for (const arrow of ['up', 'down', 'left', 'right'] as const) expect(HELPER_KEYS).toContain(arrow);
	});

	it('reaches the keys a phone has no other way to send', () => {
		// The set list is the ONLY path to these now that the popover is gone, so what it
		// carries is a product decision rather than an implementation detail.
		const reachable = new Set(HELPER_KEY_SETS.flatMap((set) => [...set.keys]));
		for (const key of ['shiftTab', 'tab', 'enter', 'backspace', 'delete', 'home', 'end', 'pageUp', 'pageDown'] as const) {
			expect(reachable.has(key), `${key} is unreachable from a phone`).toBe(true);
		}
		// ^C above all: it is the interrupt, and a phone with no way to send it cannot stop
		// a runaway process at all.
		expect(reachable.has('ctrlC'), 'a phone cannot interrupt anything').toBe(true);
	});
});
