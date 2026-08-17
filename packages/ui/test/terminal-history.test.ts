import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { HISTORY_FOLD_CHARS } from '@pdmux/core';
import TerminalHistory from '../src/components/TerminalHistory.svelte';

/**
 * ⚠ THE POINT OF THIS SUITE IS THE HONESTY RULE.
 *
 * A pane attached to a multiplexer runs it in xterm's ALTERNATE buffer, and xterm keeps no
 * scrollback for that buffer at all — the history lives inside tmux, not in this process.
 * Such a pane can only ever hand over its visible screen. Presenting that as "the output"
 * is a claim the user cannot check and would disbelieve the first time something they
 * remembered was missing, so the sheet has to say which of the two it got.
 */
describe('[TC-PDUI-180] the output sheet shows the buffer and admits what it cannot show', () => {
	it('renders the lines it was given, newest last', () => {
		const { container } = render(TerminalHistory, {
			props: { lines: ['first', 'second', 'third'], scrollback: true },
		});
		const body = container.querySelector('[data-pdmux-history-body]') as HTMLElement;
		expect(body.textContent).toBe('first\nsecond\nthird');
		expect(body.dataset.pdmuxLines).toBe('3');
	});

	it('says so when the pane only has its visible screen', () => {
		// Silence here is the bug: the user is looking at a fraction of what they asked for
		// and has no way to tell that from a terminal that printed very little.
		const { container } = render(TerminalHistory, { props: { lines: ['one screen'], scrollback: false } });
		const note = container.querySelector('[data-pdmux-history-note]');
		expect(note, 'an alternate-buffer pane claimed to show a history it does not have').not.toBeNull();
		expect((note?.textContent ?? '').length).toBeGreaterThan(10);
	});

	it('stays quiet when there really is a scrollback', () => {
		// The note must not become wallpaper, or it stops being read where it matters.
		const { container } = render(TerminalHistory, { props: { lines: ['a', 'b'], scrollback: true } });
		expect(container.querySelector('[data-pdmux-history-note]')).toBeNull();
	});

	it('separates "nothing printed" from "cannot show it"', () => {
		const { container } = render(TerminalHistory, { props: { lines: [], scrollback: true } });
		expect(container.querySelector('[data-pdmux-empty="history"]')).not.toBeNull();
		expect(container.querySelector('[data-pdmux-history-note]')).toBeNull();
	});

	/**
	 * THE THREE SILENCES, reported from a phone as "the popup has nothing in it".
	 *
	 * A sheet holding one screen looked exactly like a sheet still fetching and exactly like a
	 * sheet whose fetch had been refused — and in the worst case it said "nothing has been printed
	 * yet" about a pane that had printed for hours. The reader's only way to tell them apart was
	 * to open the dashboard on another machine, which is what actually happened.
	 */
	it('says it is still fetching, and does not call the pane empty while it is', () => {
		const { container } = render(TerminalHistory, { props: { lines: [], scrollback: false, pending: true } });
		expect(container.querySelector('[data-pdmux-history-note="pending"]')).not.toBeNull();
		// ⚠ THE LIE THIS REMOVES. "Nothing has been printed yet" is a claim about the pane, and
		// while the answer is in flight this process knows nothing about the pane.
		expect(container.querySelector('[data-pdmux-empty="history"]')).toBeNull();
	});

	it('says the host could not be asked, rather than presenting the screen as the history', () => {
		const { container } = render(TerminalHistory, {
			props: { lines: ['one screen'], scrollback: false, failed: true },
		});
		const note = container.querySelector('[data-pdmux-history-note="failed"]');
		expect(note, 'a refused fetch was shown as an ordinary short pane').not.toBeNull();
		// And not the multiplexer note, which would send the reader looking for a history that
		// nobody has been able to ask for.
		expect(container.querySelector('[data-pdmux-history-note="multiplexer"]')).toBeNull();
	});

	it('points at the program, not the multiplexer, when a full-screen program owns the pane', () => {
		/**
		 * ⚠ THE DIFFERENCE BETWEEN A SHORT HISTORY AND NO HISTORY. A coding agent's TUI draws on
		 * the pane's ALTERNATE screen and the multiplexer keeps history for the normal one, so
		 * there is nothing above the screen to fetch — measured across one fleet on 2026-08-17,
		 * 48 lines behind such a pane against 1991 behind one whose program prints normally. The
		 * old note named the multiplexer as the place the history lives, which in this case is
		 * wrong, and the only thing that can still show earlier output is the program itself.
		 */
		const { container } = render(TerminalHistory, {
			props: { lines: ['agent screen'], scrollback: true, screenOnly: true },
		});
		expect(container.querySelector('[data-pdmux-history-note="screen"]')).not.toBeNull();
		expect(container.querySelector('[data-pdmux-history-note="multiplexer"]')).toBeNull();
	});

	it('prefers the fetch state over the shape of what it is holding', () => {
		// Both are true of the same sheet at different moments; a reader can only act on one, and
		// "we are still asking" outranks "this is one screen".
		const { container } = render(TerminalHistory, {
			props: { lines: ['one screen'], scrollback: false, screenOnly: true, pending: true },
		});
		expect(container.querySelector('[data-pdmux-history-note="pending"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-pdmux-history-note]').length).toBe(1);
	});

	it('hands the whole buffer to a copy, joined as it reads', () => {
		// Copying a stack trace out of here is half the reason the sheet exists.
		const onCopy = vi.fn();
		const { container } = render(TerminalHistory, { props: { lines: ['x', 'y'], scrollback: true, onCopy } });
		(container.querySelector('[data-testid="terminal-history-copy"]') as HTMLElement).click();
		expect(onCopy).toHaveBeenCalledWith('x\ny');
	});

	it('closes from the button and from Escape', () => {
		const onClose = vi.fn();
		const { container } = render(TerminalHistory, { props: { lines: ['x'], onClose } });
		(container.querySelector('[data-testid="terminal-history-close"]') as HTMLElement).click();
		expect(onClose).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('keeps the scrollable block reachable from a keyboard', () => {
		// A scrollable region with no tabstop cannot be scrolled without a pointer, which
		// on this sheet means most of the output is unreachable.
		const { container } = render(TerminalHistory, { props: { lines: ['x'], scrollback: true } });
		const body = container.querySelector('[data-pdmux-history-body]') as HTMLElement;
		expect(body.getAttribute('tabindex')).toBe('0');
		expect(body.getAttribute('role')).toBe('region');
		expect((body.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
	});
});

describe('[TC-PDUI-218] the sheet shows the colours the pane was drawn in', () => {
	const RED = { kind: 'palette' as const, index: 1 };

	it('paints each run and still reads as the exact text it was given', () => {
		const { container } = render(TerminalHistory, {
			props: {
				lines: [[{ text: 'error', fg: RED, bold: true }, { text: ': nope' }], 'plain'],
				scrollback: true,
			},
		});
		const body = container.querySelector('[data-pdmux-history-body]') as HTMLElement;
		/**
		 * ⚠ THE NEWLINE IS THE WHOLE TRAP. `textContent` of `<div>a</div><div>b</div>` is
		 * `ab` — one block per line silently deletes every line break, and with it the
		 * copy, the browser's find and the promise that this sheet reads as its source.
		 */
		expect(body.textContent).toBe('error: nope\nplain');

		const painted = container.querySelector('[data-pdmux-line="0"] span') as HTMLElement;
		expect(painted.textContent).toBe('error');
		// jsdom normalises an inline style, so the assertion is on the resolved value.
		expect(painted.style.color).toBe('rgb(216, 30, 0)');
		expect(painted.style.fontWeight).toBe('600');
		// A plain line stays one text node — no span, nothing to style.
		expect(container.querySelector('[data-pdmux-line="1"] span')).toBeNull();
	});

	it('swaps the two colours for an inverted run rather than ignoring it', () => {
		// Inverse is how a prompt marker and a selection are drawn; rendering it as normal
		// text loses the only thing that made it stand out.
		const { container } = render(TerminalHistory, {
			props: { lines: [[{ text: 'sel', fg: RED, inverse: true }]], scrollback: true },
		});
		const painted = container.querySelector('[data-pdmux-line="0"] span') as HTMLElement;
		// The run said RED foreground; inverted, red becomes the BACKGROUND.
		expect(painted.style.backgroundColor).toBe('rgb(216, 30, 0)');
		expect(painted.style.color).toBe('rgb(43, 43, 43)');
	});

	it('folds a very long line by HIDING it, never by cutting it', async () => {
		const long = 'x'.repeat(HISTORY_FOLD_CHARS + 50);
		const { container } = render(TerminalHistory, { props: { lines: [long, 'short'], scrollback: true } });

		const line = container.querySelector('[data-pdmux-line="0"]') as HTMLElement;
		const toggle = container.querySelector('[data-pdmux-fold-line="0"]') as HTMLButtonElement;
		expect(line.getAttribute('data-pdmux-folded')).toBe('true');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		// A short line gets no control at all — a toggle that does nothing is noise.
		expect(container.querySelector('[data-pdmux-fold-line="1"]')).toBeNull();

		/**
		 * ⚠ THE TEXT IS ALL STILL THERE. Folding is a CSS clip, so a selection, a browser
		 * find and this assertion all see the whole line. Slicing the string instead would
		 * make the sheet lossy in exactly the case folding was added for.
		 */
		const body = container.querySelector('[data-pdmux-history-body]') as HTMLElement;
		expect(body.textContent).toBe(`${long}\nshort`);
		// ⚠ AND THE CONTROL CONTRIBUTES NO TEXT. Its glyph comes from CSS `content`, so it
		// cannot end up inside a copied block that has to equal the output.
		expect(toggle.textContent).toBe('');
		expect((toggle.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);

		fireEvent.click(toggle);
		await tick();
		expect(container.querySelector('[data-pdmux-line="0"]')?.getAttribute('data-pdmux-folded')).toBeNull();
	});

	it('copies the plain text, never the escapes and never the markup', () => {
		const onCopy = vi.fn();
		const { container } = render(TerminalHistory, {
			props: { lines: [[{ text: 'red', fg: RED }, { text: ' tail' }], 'plain'], scrollback: true, onCopy },
		});
		fireEvent.click(container.querySelector('[data-testid="terminal-history-copy"]') as HTMLElement);
		expect(onCopy).toHaveBeenCalledWith('red tail\nplain');
	});
});
