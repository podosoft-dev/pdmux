/**
 * Terminal output as attributed text.
 *
 * These run over bytes a stranger's program produced, so most of the value here is in
 * the refusals: an unknown attribute must not blank a line, a cursor move must not eat
 * the text after it, and a truncated escape at a line boundary must not throw.
 */
import { describe, expect, it } from 'vitest';
import {
	HISTORY_FOLD_CHARS,
	type HistorySpan,
	historyFoldable,
	historyPlain,
	historyText,
	parseAnsiLine,
	parseAnsiLines,
	xterm256,
} from '../src/index.js';

const ESC = '';
const spans = (line: ReturnType<typeof parseAnsiLine>): HistorySpan[] => {
	expect(Array.isArray(line), `expected attributed runs, got ${JSON.stringify(line)}`).toBe(true);
	return line as HistorySpan[];
};

describe('[TC-PDCORE-097] terminal output keeps the colours it was written in', () => {
	it('leaves plain text a plain string, and trims the padding a terminal adds', () => {
		// ⚠ THE STRING FORM IS NOT AN OPTIMISATION. It is what keeps the sheet's markup a
		// single text node for the overwhelming majority of lines.
		expect(parseAnsiLine('hello')).toBe('hello');
		expect(parseAnsiLine('hello      ')).toBe('hello');
		expect(parseAnsiLine('')).toBe('');
		expect(parseAnsiLine(undefined as unknown as string)).toBe('');
	});

	it('reads the basic, bright and extended colours', () => {
		expect(spans(parseAnsiLine(`${ESC}[31mred${ESC}[0m`))[0]).toMatchObject({
			text: 'red',
			fg: { kind: 'palette', index: 1 },
		});
		// The bright pairs: `ls` and most prompts live here, so leaving them out would
		// have shown real output in the dull half of the palette.
		expect(spans(parseAnsiLine(`${ESC}[92mgreen`))[0]?.fg).toEqual({ kind: 'palette', index: 10 });
		expect(spans(parseAnsiLine(`${ESC}[38;5;208morange`))[0]?.fg).toEqual({ kind: 'palette', index: 208 });
		expect(spans(parseAnsiLine(`${ESC}[38;2;18;52;86mtrue`))[0]?.fg).toEqual({ kind: 'rgb', value: 0x123456 });
		expect(spans(parseAnsiLine(`${ESC}[45mon-magenta`))[0]?.bg).toEqual({ kind: 'palette', index: 5 });
		// ⚠ The parts of an extended colour must not be re-read as attributes of their
		// own: `2;255;0;0` as separate codes would become dim + nothing.
		const truecolour = spans(parseAnsiLine(`${ESC}[38;2;255;0;0mred`))[0];
		expect(truecolour?.fg).toEqual({ kind: 'rgb', value: 0xff0000 });
		expect(truecolour?.dim).toBeUndefined();
	});

	it('breaks a run only where the attributes actually change', () => {
		const line = spans(parseAnsiLine(`${ESC}[31mred${ESC}[31m still red${ESC}[32m green`));
		expect(line).toHaveLength(2);
		expect(line[0]?.text).toBe('red still red');
		expect(line[1]?.text).toBe(' green');
	});

	it('turns intensity off with 22, which owns bold AND dim', () => {
		// Treating 22 as "not bold" leaves dim text stuck dim for the rest of the line.
		const line = spans(parseAnsiLine(`${ESC}[1m${ESC}[2mboth${ESC}[22mneither`));
		expect(line[0]).toMatchObject({ text: 'both', bold: true, dim: true });
		expect(line[1]?.bold).toBeUndefined();
		expect(line[1]?.dim).toBeUndefined();
	});

	it('resets everything on 0, and on a bare ESC[m', () => {
		for (const reset of [`${ESC}[0m`, `${ESC}[m`]) {
			const line = spans(parseAnsiLine(`${ESC}[1;31;45mloud${reset}quiet`));
			expect(line[0]).toMatchObject({ bold: true, fg: { kind: 'palette', index: 1 } });
			expect(line[1]?.text).toBe('quiet');
			expect(line[1]?.fg).toBeUndefined();
			expect(line[1]?.bg).toBeUndefined();
			expect(line[1]?.bold).toBeUndefined();
		}
	});

	it('drops the escapes that mean nothing here WITHOUT eating the text around them', () => {
		// A capture carries cursor moves, erases and window titles. Swallowing the rest
		// of the line on one of them is the failure this case exists for.
		expect(parseAnsiLine(`before${ESC}[2Kafter`)).toBe('beforeafter');
		expect(parseAnsiLine(`a${ESC}[10;20Hb`)).toBe('ab');
		expect(parseAnsiLine(`x${ESC}]0;a window title${ESC}\\y`)).toBe('xy');
		expect(parseAnsiLine(`x${ESC}]0;bell terminatedy`)).toBe('xy');
		expect(parseAnsiLine(`keep${ESC}(Bgoing`)).toBe('keepgoing');
	});

	it('survives junk without throwing or blanking the line', () => {
		// A truncated sequence at a line boundary is ordinary — a capture cuts wherever
		// the pane wrapped.
		expect(parseAnsiLine(`text${ESC}[3`)).toBe('text');
		expect(parseAnsiLine(`text${ESC}`)).toBe('text');
		expect(historyText(parseAnsiLine(`${ESC}[99mweird${ESC}[0m`))).toBe('weird');
		expect(historyText(parseAnsiLine(`${ESC}[38;9;1mbogus`))).toBe('bogus');
	});

	it('trims padding that hides behind a reset, and drops the blank tail', () => {
		/**
		 * ⚠ THIS IS WHY THE TRIM CANNOT LIVE OUTSIDE THE PARSER. With escapes in the
		 * stream a line ends in `ESC[0m` AFTER its padding, so `/\s+$/` matches nothing:
		 * every line stays 80-200 spaces wide and no line ever looks blank.
		 */
		expect(parseAnsiLine(`${ESC}[32mok${ESC}[0m        `)).toEqual([
			{ text: 'ok', fg: { kind: 'palette', index: 2 } },
		]);
		expect(parseAnsiLine(`   ${ESC}[0m   `)).toBe('');
		expect(parseAnsiLines(['a', `${ESC}[0m   `, '   ', ''])).toEqual(['a']);
		expect(parseAnsiLines(['a', '', 'b'])).toEqual(['a', '', 'b']);
	});

	it('hands a copy the plain text, whatever the line is made of', () => {
		const lines = [parseAnsiLine(`${ESC}[31mred${ESC}[0m line`), 'plain'];
		expect(historyPlain(lines)).toBe('red line\nplain');
		expect(historyText('plain')).toBe('plain');
	});

	it('calls a line foldable by its characters, not by its rendered height', () => {
		// Height needs layout, so the answer would differ between a server render and a
		// client one and the sheet would reflow on hydrate.
		expect(historyFoldable('x'.repeat(HISTORY_FOLD_CHARS))).toBe(false);
		expect(historyFoldable('x'.repeat(HISTORY_FOLD_CHARS + 1))).toBe(true);
		expect(historyFoldable([{ text: 'x'.repeat(HISTORY_FOLD_CHARS + 1), bold: true }])).toBe(true);
	});

	it('computes the 256-colour cube the way xterm does', () => {
		// The cube's levels are NOT evenly spaced — 0, then 95 + 40n. Getting it wrong
		// makes a whole family of colours subtly muddy.
		expect(xterm256(16)).toBe(0x000000);
		expect(xterm256(231)).toBe(0xffffff);
		expect(xterm256(196)).toBe(0xff0000);
		expect(xterm256(46)).toBe(0x00ff00);
		expect(xterm256(232)).toBe(0x080808);
		expect(xterm256(255)).toBe(0xeeeeee);
		// Out of range is a number, never a throw: this runs inside a render.
		expect(xterm256(15)).toBe(0);
		expect(xterm256(1.5)).toBe(0);
	});
});
