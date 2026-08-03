import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
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
