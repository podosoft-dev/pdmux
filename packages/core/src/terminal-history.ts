/**
 * Terminal output as attributed text — what the output sheet renders.
 *
 * WHY A MODEL RATHER THAN A STRING: the sheet has TWO producers and they lose colour
 * in two different ways. A multiplexer pane's history arrives from `tmux capture-pane`
 * as bytes with SGR escapes in them; a plain shell pane's history is already in the
 * browser as xterm cells carrying attributes. Both were being flattened — one by
 * dropping `-e`, the other by `translateToString()` — and the sheet showed grey text
 * for output the pane beside it was drawing in colour. They meet here so there is one
 * renderer instead of two, and so the parsing is testable without a browser.
 *
 * ⚠ COLOURS ARE NOT RESOLVED HERE. A palette index is what the bytes said; WHICH grey
 * index 8 is belongs to the product's terminal theme, which is a pixel decision and
 * lives in `@pdmux/ui`. Indices 16-255 are the standard cube and greyscale ramp — an
 * arithmetic fact rather than a choice — so that one IS computed here.
 */

/** A colour as the stream expressed it. `palette` is 0-255; `rgb` is 0xRRGGBB. */
export type HistoryColor = { kind: 'palette'; index: number } | { kind: 'rgb'; value: number };

/** A run of characters sharing one set of attributes. */
export interface HistorySpan {
	text: string;
	fg?: HistoryColor;
	bg?: HistoryColor;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	/** Swap foreground and background at render time (SGR 7). */
	inverse?: boolean;
}

/**
 * One line.
 *
 * A bare string is the shorthand for "one run, no attributes" — the overwhelming
 * majority of lines — so a caller with nothing to say about colour stays readable and
 * the wire stays small.
 */
export type HistoryLine = string | HistorySpan[];

/** The plain text of a line: what a copy produces and what a reader selects. */
export function historyText(line: HistoryLine): string {
	if (typeof line === 'string') return line;
	let out = '';
	for (const span of line) out += span.text;
	return out;
}

/** Plain text for a whole sheet, in the order it reads. */
export function historyPlain(lines: readonly HistoryLine[]): string {
	return lines.map(historyText).join('\n');
}

/**
 * Is this line long enough to be worth folding?
 *
 * ⚠ MEASURED IN CHARACTERS, NOT IN RENDERED HEIGHT. Height needs layout, which means
 * the answer would differ between the server render and the client one and the sheet
 * would visibly reflow on hydrate. A character count is stable everywhere and is what
 * actually correlates with the problem: one 30,000-character line of minified output
 * that pushes the rest of the history off the screen.
 */
export const HISTORY_FOLD_CHARS = 400;

export function historyFoldable(line: HistoryLine): boolean {
	return historyText(line).length > HISTORY_FOLD_CHARS;
}

/**
 * Palette index 16-255 as 0xRRGGBB.
 *
 * 16-231 is a 6x6x6 cube whose levels are NOT evenly spaced — the first step is 0 and
 * the rest are 95 + 40n, which is xterm's own table. 232-255 is a 24-step greyscale
 * starting at 8. Getting either wrong makes a whole family of colours subtly muddy,
 * which is the kind of thing nobody reports and everybody notices.
 */
export function xterm256(index: number): number {
	if (!Number.isInteger(index) || index < 16 || index > 255) return 0;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return (level << 16) | (level << 8) | level;
	}
	const offset = index - 16;
	const step = (value: number): number => (value === 0 ? 0 : 95 + (value - 1) * 40);
	const r = step(Math.floor(offset / 36) % 6);
	const g = step(Math.floor(offset / 6) % 6);
	const b = step(offset % 6);
	return (r << 16) | (g << 8) | b;
}

/** Everything one SGR state can say. Mutated as the parser walks a line. */
interface Attrs {
	fg?: HistoryColor;
	bg?: HistoryColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	inverse: boolean;
}

const blank = (): Attrs => ({
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	strike: false,
	inverse: false,
});

const ESC = '';

/**
 * Parse one line of terminal bytes into attributed runs.
 *
 * ⚠ ESCAPES THAT ARE NOT SGR ARE DROPPED, AND THE TEXT AROUND THEM IS NOT. A capture
 * carries cursor moves, erases and OSC titles that mean nothing in a static sheet; a
 * parser that gave up on them would swallow the rest of the line, and one that printed
 * them would show `[2K` to the reader. Both were seen in the wild before this existed.
 *
 * ⚠ AND THE TRAILING TRIM HAPPENS HERE, WHICH IS THE ONLY PLACE IT CAN. A terminal pads
 * every line to the pane width, so without a trim each line carries 80-200 spaces. But
 * with escapes in the stream a line ends in `ESC[0m` AFTER that padding, so a naive
 * `/\s+$/` matches nothing and every line stays padded — and the "is this line blank"
 * test never fires either. Only something that has already separated text from escapes
 * can answer, so the trim is part of parsing rather than a step before or after it.
 */
export function parseAnsiLine(raw: string): HistoryLine {
	if (typeof raw !== 'string') return '';
	// The common case by a wide margin: no escapes at all. Skip everything below and,
	// crucially, return the STRING form so the sheet's markup stays one text node.
	if (!raw.includes(ESC)) return trimEnd(raw);

	const spans: HistorySpan[] = [];
	const attrs = blank();
	let text = '';
	let index = 0;

	/**
	 * ⚠ MERGES INTO THE PREVIOUS RUN WHEN NOTHING ACTUALLY CHANGED. Real output repeats
	 * the same SGR constantly — a prompt theme re-states its colour before every
	 * segment, and `grep --color` closes and reopens the same attribute around each
	 * match. Splitting on the escape rather than on the CHANGE turned one coloured word
	 * into a dozen spans, which is a dozen DOM nodes per line for no visible difference.
	 */
	const flush = (): void => {
		if (text.length === 0) return;
		const span = spanOf(text, attrs);
		const previous = spans[spans.length - 1];
		if (previous && sameAttrs(previous, span)) previous.text += span.text;
		else spans.push(span);
		text = '';
	};

	while (index < raw.length) {
		const char = raw[index] as string;
		if (char !== ESC) {
			text += char;
			index += 1;
			continue;
		}
		const next = raw[index + 1];
		if (next === '[') {
			// CSI: parameters, then one final byte in 0x40-0x7e.
			let end = index + 2;
			while (end < raw.length) {
				const code = raw.charCodeAt(end);
				if (code >= 0x40 && code <= 0x7e) break;
				end += 1;
			}
			if (end >= raw.length) break; // truncated sequence at the end of a line
			if (raw[end] === 'm') {
				flush();
				applySgr(attrs, raw.slice(index + 2, end));
			}
			index = end + 1;
			continue;
		}
		if (next === ']') {
			// OSC: runs to BEL or ST. A window title has no place in the sheet.
			let end = index + 2;
			while (end < raw.length && raw[end] !== '' && !(raw[end] === ESC && raw[end + 1] === '\\')) end += 1;
			index = end < raw.length && raw[end] === '' ? end + 1 : end + 2;
			continue;
		}
		if (next !== undefined && next >= ' ' && next <= '/') {
			// An escape with intermediate bytes — `ESC ( B` designates a charset and is
			// THREE bytes. Dropping only two left its final byte in the text as a stray
			// `B`, which is exactly the kind of thing that reads as corrupted output.
			let end = index + 1;
			while (end < raw.length && (raw[end] as string) >= ' ' && (raw[end] as string) <= '/') end += 1;
			index = end + 1;
			continue;
		}
		// A two-byte escape (or a stray ESC at the very end): drop the pair.
		index += next === undefined ? 1 : 2;
	}
	flush();

	trimSpans(spans);
	if (spans.length === 0) return '';
	// A single unattributed run is just a string; keeping it as one keeps the DOM flat.
	if (spans.length === 1 && isPlain(spans[0] as HistorySpan)) return (spans[0] as HistorySpan).text;
	return spans;
}

/** Trailing whitespace is padding, not content — see `parseAnsiLine`. */
function trimEnd(text: string): string {
	return text.replace(/[ \t]+$/, '');
}

/** Drop padding from the end of the last run, then drop runs that became empty. */
function trimSpans(spans: HistorySpan[]): void {
	while (spans.length > 0) {
		const last = spans[spans.length - 1] as HistorySpan;
		last.text = trimEnd(last.text);
		if (last.text.length > 0) break;
		spans.pop();
	}
}

/** Do two runs carry the same attributes? Colours compare by value, not identity. */
function sameAttrs(a: HistorySpan, b: HistorySpan): boolean {
	return (
		sameColor(a.fg, b.fg) &&
		sameColor(a.bg, b.bg) &&
		a.bold === b.bold &&
		a.dim === b.dim &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.strike === b.strike &&
		a.inverse === b.inverse
	);
}

function sameColor(a: HistoryColor | undefined, b: HistoryColor | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.kind !== b.kind) return false;
	return a.kind === 'palette' ? a.index === (b as { index: number }).index : a.value === (b as { value: number }).value;
}

function isPlain(span: HistorySpan): boolean {
	return (
		span.fg === undefined &&
		span.bg === undefined &&
		!span.bold &&
		!span.dim &&
		!span.italic &&
		!span.underline &&
		!span.strike &&
		!span.inverse
	);
}

function spanOf(text: string, attrs: Attrs): HistorySpan {
	const span: HistorySpan = { text };
	if (attrs.fg) span.fg = attrs.fg;
	if (attrs.bg) span.bg = attrs.bg;
	if (attrs.bold) span.bold = true;
	if (attrs.dim) span.dim = true;
	if (attrs.italic) span.italic = true;
	if (attrs.underline) span.underline = true;
	if (attrs.strike) span.strike = true;
	if (attrs.inverse) span.inverse = true;
	return span;
}

/**
 * Apply one SGR parameter list.
 *
 * ⚠ AN UNKNOWN PARAMETER IS SKIPPED, NEVER FATAL. This runs over bytes a stranger's
 * program produced; a parser that threw would blank the sheet for one exotic attribute.
 */
function applySgr(attrs: Attrs, params: string): void {
	// `ESC[m` means `ESC[0m`, and an empty parameter inside a list means zero too.
	const codes = params.split(';').map((part) => (part === '' ? 0 : Number.parseInt(part, 10)));
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index];
		if (code === undefined || Number.isNaN(code)) continue;
		switch (true) {
			case code === 0: {
				const reset = blank();
				attrs.fg = undefined;
				attrs.bg = undefined;
				attrs.bold = reset.bold;
				attrs.dim = reset.dim;
				attrs.italic = reset.italic;
				attrs.underline = reset.underline;
				attrs.strike = reset.strike;
				attrs.inverse = reset.inverse;
				break;
			}
			case code === 1:
				attrs.bold = true;
				break;
			case code === 2:
				attrs.dim = true;
				break;
			case code === 3:
				attrs.italic = true;
				break;
			case code === 4:
				attrs.underline = true;
				break;
			case code === 7:
				attrs.inverse = true;
				break;
			case code === 9:
				attrs.strike = true;
				break;
			// 22 clears BOTH bold and dim — they are one intensity attribute, and
			// treating 22 as "not bold" leaves dim text stuck dim for the rest of a line.
			case code === 22:
				attrs.bold = false;
				attrs.dim = false;
				break;
			case code === 23:
				attrs.italic = false;
				break;
			case code === 24:
				attrs.underline = false;
				break;
			case code === 27:
				attrs.inverse = false;
				break;
			case code === 29:
				attrs.strike = false;
				break;
			case code >= 30 && code <= 37:
				attrs.fg = { kind: 'palette', index: code - 30 };
				break;
			case code === 38:
				index = extended(codes, index, (colour) => (attrs.fg = colour));
				break;
			case code === 39:
				attrs.fg = undefined;
				break;
			case code >= 40 && code <= 47:
				attrs.bg = { kind: 'palette', index: code - 40 };
				break;
			case code === 48:
				index = extended(codes, index, (colour) => (attrs.bg = colour));
				break;
			case code === 49:
				attrs.bg = undefined;
				break;
			// The bright pairs. `ls` and every prompt theme lean on these, so leaving
			// them out would have shown most real output in the dull half of the palette.
			case code >= 90 && code <= 97:
				attrs.fg = { kind: 'palette', index: code - 90 + 8 };
				break;
			case code >= 100 && code <= 107:
				attrs.bg = { kind: 'palette', index: code - 100 + 8 };
				break;
			default:
				break;
		}
	}
}

/**
 * `38`/`48` followed by `5;n` (palette) or `2;r;g;b` (true colour).
 *
 * Returns the index of the last parameter consumed, so the caller's loop resumes after
 * the colour rather than re-reading its parts as attributes of their own — reading
 * `2;255;0;0` as separate codes would turn a red into dim + nothing.
 */
function extended(codes: (number | undefined)[], at: number, set: (colour: HistoryColor) => void): number {
	const mode = codes[at + 1];
	if (mode === 5) {
		const index = codes[at + 2];
		if (index !== undefined && index >= 0 && index <= 255) set({ kind: 'palette', index });
		return at + 2;
	}
	if (mode === 2) {
		const [r, g, b] = [codes[at + 2], codes[at + 3], codes[at + 4]];
		if (r !== undefined && g !== undefined && b !== undefined) {
			const clamp = (value: number): number => Math.min(255, Math.max(0, value));
			set({ kind: 'rgb', value: (clamp(r) << 16) | (clamp(g) << 8) | clamp(b) });
		}
		return at + 4;
	}
	return at;
}

/**
 * Parse a whole capture and drop the blank tail.
 *
 * The tail is the unused part of a pane, not content — and it can only be recognised
 * after parsing, because a "blank" line from a capture is usually spaces followed by a
 * reset sequence.
 */
export function parseAnsiLines(raw: readonly string[]): HistoryLine[] {
	const lines = raw.map(parseAnsiLine);
	while (lines.length > 0 && historyText(lines[lines.length - 1] as HistoryLine) === '') lines.pop();
	return lines;
}
