/**
 * The clipboard write behind the terminal's copy shortcut.
 *
 * A self-hosted deployment is reachable over plain http while it is being set up,
 * where `navigator.clipboard` does not exist at all — losing copy there would be
 * the bug this code was written to fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { selectionCopier, writeClipboard } from '../src/adapters/terminal-surface.js';

describe('[TC-PDUI-050] copying text survives a hostile clipboard', () => {
	it('[TC-PDUI-050] uses the async clipboard when it is available', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		await writeClipboard('hello', { writeText });
		expect(writeText).toHaveBeenCalledWith('hello');
	});

	it('[TC-PDUI-050] falls back when the write is refused, and never throws', async () => {
		const exec = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
		await expect(writeClipboard('x', { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).resolves.toBeUndefined();
		expect(exec).toHaveBeenCalledWith('copy');
	});

	it('[TC-PDUI-050] falls back when there is no clipboard API at all', async () => {
		const exec = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
		await writeClipboard('y', null);
		expect(exec).toHaveBeenCalled();
		// The temporary textarea must not survive: an off-screen node left in the
		// document steals focus and selection from the terminal it just served.
		expect(document.querySelectorAll('textarea').length).toBe(0);
	});
});

describe('[TC-PDUI-193] letting go of a selection copies it', () => {
	/**
	 * REPORTED: "dragging does not copy". Two things were missing
	 * and this is the second half: even once a drag reached xterm (the click guard used to
	 * occlude the surface and eat it), the selection just sat there. The only copy path was
	 * a keyboard shortcut, which is not what anybody means by "select and copy" — tmux,
	 * iTerm2, PuTTY and every X11 terminal have copied on release for decades.
	 *
	 * The rule is driven by xterm's own `onSelectionChange`, which fires once per settled
	 * change inside its mouseup — so there is no frame to wait for and no gesture to miss.
	 */
	it('[TC-PDUI-193] copies what was selected', () => {
		const copy = vi.fn();
		let selection = 'npm run dev';
		const settled = selectionCopier({ getSelection: () => selection }, copy);
		settled();
		expect(copy).toHaveBeenCalledWith('npm run dev');

		selection = 'a second drag';
		settled();
		expect(copy).toHaveBeenLastCalledWith('a second drag');
		expect(copy).toHaveBeenCalledTimes(2);
	});

	it('[TC-PDUI-193] leaves the clipboard alone when nothing is selected', () => {
		/**
		 * ⚠ THE HALF THAT PROTECTS THE USER. A plain click CLEARS the selection and fires the
		 * same event, and so does a multiplexer swapping to its alternate screen — writing ""
		 * then would silently wipe whatever they had on their clipboard, which is a far worse
		 * bug than the one being fixed.
		 */
		const copy = vi.fn();
		selectionCopier({ getSelection: () => '' }, copy)();
		expect(copy).not.toHaveBeenCalled();
	});

	it('[TC-PDUI-193] copies the same text again when it is selected again', () => {
		/**
		 * ⚠ NO DEDUPE, ON PURPOSE. A "skip an identical selection" guard was written here as
		 * belt and braces and it broke re-selection outright: xterm does not reliably
		 * announce the CLEAR between two selections, so picking the same line a second time
		 * matched the remembered value and copied nothing at all. Measured in a browser —
		 * Option+drag silently stopped working because Shift+drag had just copied that line.
		 * Writing the same string twice costs nothing; refusing to costs the user their copy.
		 */
		const copy = vi.fn();
		const settled = selectionCopier({ getSelection: () => 'same text' }, copy);
		settled();
		settled();
		expect(copy).toHaveBeenCalledTimes(2);
	});
});
