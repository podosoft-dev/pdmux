/**
 * The rendering half of a terminal pane, kept behind a factory.
 *
 * WHY INJECTABLE: xterm.js measures glyphs on a canvas, which a jsdom test
 * environment does not have. Passing the factory in means the pane's wiring (open,
 * data both ways, resize, close) is testable without a browser, while the shipped
 * default is the real terminal.
 */
// Type-only: erased at build, so it adds nothing to the module graph the dev server
// externalises — a runtime import here would need a dev-server restart to be seen.
import type { HistoryColor, HistoryLine, HistorySpan } from '@pdmux/core';

/**
 * What a pane can read back out of its terminal.
 *
 * ⚠ `lines` IS NOT ALWAYS THE HISTORY. A pane pointed at a multiplexer session runs it in
 * xterm's ALTERNATE buffer, and xterm keeps no scrollback for that buffer at all — the
 * history lives inside tmux, not here. So a session pane reports its visible screen and
 * says so; only a plain `shell` pane has the 5000 lines. Anything that renders this has to
 * tell the user which it got, or it is claiming to show a history it does not have.
 */
export interface TerminalHistory {
	/**
	 * Attributed lines. A bare string is the shorthand for "no attributes", which is
	 * what most lines are — see `@pdmux/core`'s `HistoryLine`.
	 */
	lines: HistoryLine[];
	/** False when the buffer is alternate, i.e. these lines are one screen, not a history. */
	scrollback: boolean;
}

export interface TerminalSurface {
	write(data: string): void;
	/** Called when the pane resizes; returns the geometry to report upstream. */
	fit(): { cols: number; rows: number };
	focus(): void;
	onData(listener: (data: string) => void): () => void;
	dispose(): void;
	/**
	 * Scroll by whole screens. Negative is back through the history.
	 *
	 * Exists because a phone has no wheel — so this IS one. It hands the terminal the same
	 * wheel event a mouse would and lets it route it, because which of the three possible
	 * answers is right depends on what the program is doing right now, and only the terminal
	 * knows that. See `createXtermSurface`.
	 */
	scrollPages(delta: number): void;
	/**
	 * Whether a wheel would reach anything here.
	 *
	 * ⚠ A QUESTION, NOT A FACT TO CACHE — the answer changes while the pane runs. See
	 * `createXtermSurface`, and `TerminalPane`, which asks again as output arrives.
	 */
	canScroll(): boolean;
	/**
	 * Shift+wheel landed on a buffer with no local history — the pane is attached to a
	 * multiplexer and only IT can show what scrolled past.
	 *
	 * ⚠ A REQUEST, NOT AN ACTION. This package may not talk to a server (`[TC-PDUI-030]`), and the
	 * answer is a command on a remote host; the consumer decides whether, and how often,
	 * to ask. `-1` is back through the history.
	 */
	onScrollbackRequest(listener: (direction: -1 | 1) => void): () => void;
	/** The buffer as text, newest last. */
	readHistory(): TerminalHistory;
}

export type TerminalSurfaceFactory = (host: HTMLElement) => Promise<TerminalSurface> | TerminalSurface;

/**
 * The terminal's colours, taken from the browser-terminal client this product replaced.
 *
 * WHY NOT PURE BLACK: this factory used to pass `theme: { background: '#000000' }` and
 * readers found it harsh. The in-house dashboard pdmux generalises did not look like that,
 * and the reason is that its terminal server shipped a palette of its own rather than using
 * xterm.js's stock theme. That client was still installed on the machine, so the values
 * below are read out of it verbatim — its default terminal options carried
 * `fontSize: 13` and this exact 16-colour palette, and the only flag its service passed
 * (`macOptionIsMeta`) is merged over a different options object and never touches the theme.
 *
 * For contrast, xterm.js's own defaults are `#000000` background / `#ffffff` foreground /
 * `#ffffff` cursor (`@xterm/xterm` 5.5.0, `ThemeService.ts` `DEFAULT_BACKGROUND` and
 * friends) — i.e. exactly the black being replaced here. The softness was never xterm's, so
 * this does NOT fall back to the product's own `--pdmux-bg`/`--pdmux-card` tokens: a real
 * palette exists, and inventing one would drop the 16 ANSI colours programs paint with.
 *
 * SELECTION is pinned rather than inherited. The old client left `selectionBackground`
 * unset, so xterm's stock `rgba(255,255,255,0.3)` applied; over `#2b2b2b` that composites to
 * about `#6b6b6b`, which stays legible under `#d2d2d2` text. Naming it (and the inactive
 * variant, whose default is the same) reproduces the old look and stops it drifting if xterm
 * changes its defaults. `cursorAccent` is left unset on purpose: xterm's `#000000` default is
 * the glyph colour inside the `#adadad` cursor block, which is what the old client showed.
 *
 * KEEP IN SYNC: `.pdmux-pane-body` in styles.css paints `--pdmux-term-bg` behind the canvas
 * and must equal `background` here, or every xterm re-measure on resize flashes a seam of
 * the wrong colour.
 */
export const TERMINAL_THEME = {
	foreground: '#d2d2d2',
	background: '#2b2b2b',
	cursor: '#adadad',
	selectionBackground: 'rgba(255, 255, 255, 0.3)',
	selectionInactiveBackground: 'rgba(255, 255, 255, 0.3)',
	black: '#000000',
	red: '#d81e00',
	green: '#5ea702',
	yellow: '#cfae00',
	blue: '#427ab3',
	magenta: '#89658e',
	cyan: '#00a7aa',
	white: '#dbded8',
	brightBlack: '#686a66',
	brightRed: '#f54235',
	brightGreen: '#99e343',
	brightYellow: '#fdeb61',
	brightBlue: '#84b0d8',
	brightMagenta: '#bc94b7',
	brightCyan: '#37e6e8',
	brightWhite: '#f1f1f0',
} as const;

/**
 * 13px, because that is what the old client demonstrably used — the same default options
 * object that carried the palette above opens with `fontSize: 13`. (Its font *stack* is left
 * alone: the request was for the colours, and the family is a separate call.)
 */
export const TERMINAL_FONT_SIZE = 13;

/** What `getCell` fills in — the subset this module reads. Structural, so no import. */
interface Cell {
	getChars(): string;
	getWidth(): number;
	getFgColor(): number;
	getBgColor(): number;
	isFgDefault(): boolean;
	isBgDefault(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isStrikethrough(): number;
	isInverse(): number;
	isAttributeDefault(): boolean;
}

interface Line {
	length: number;
	isWrapped: boolean;
	translateToString(trimRight?: boolean): string;
	getCell(x: number, cell?: unknown): Cell | undefined;
}

/**
 * One buffer line as attributed runs.
 *
 * ⚠ THE FAST PATH IS THE POINT. A terminal line is usually one colour or none at all, so
 * a line whose cells are all default never builds a single object — it returns the string
 * form and the sheet renders one text node. Only lines that actually carry attributes pay
 * for spans, which is what keeps opening the sheet on a 5000-line buffer cheap.
 */
function readLine(line: Line, cell: unknown): HistoryLine {
	const spans: HistorySpan[] = [];
	let text = '';
	let attrs: HistorySpan | null = null;
	let plain = true;

	const flush = (): void => {
		if (text.length === 0) return;
		spans.push(attrs === null ? { text } : { ...attrs, text });
		text = '';
	};

	for (let x = 0; x < line.length; x++) {
		const at = line.getCell(x, cell);
		if (!at) continue;
		// Width 0 is the trailing half of a wide glyph — its characters belong to the
		// cell before it and reading them again would double every CJK character.
		if (at.getWidth() === 0) continue;
		const next = at.isAttributeDefault() ? null : styleOf(at);
		if (!sameStyle(attrs, next)) {
			flush();
			attrs = next;
			if (next !== null) plain = false;
		}
		// An empty cell is a space: a terminal pads with them and `getChars()` is ''.
		text += at.getChars() || ' ';
	}
	flush();

	// Trailing padding is the width of the pane, not content.
	while (spans.length > 0) {
		const last = spans[spans.length - 1] as HistorySpan;
		last.text = last.text.replace(/[ \t]+$/, '');
		if (last.text.length > 0) break;
		spans.pop();
	}
	if (spans.length === 0) return '';
	if (plain) return spans.map((span) => span.text).join('');
	return spans;
}

function styleOf(at: Cell): HistorySpan {
	const span: HistorySpan = { text: '' };
	const fg = colorOf(at.isFgDefault(), at.isFgPalette(), at.getFgColor());
	const bg = colorOf(at.isBgDefault(), at.isBgPalette(), at.getBgColor());
	if (fg) span.fg = fg;
	if (bg) span.bg = bg;
	if (at.isBold()) span.bold = true;
	if (at.isDim()) span.dim = true;
	if (at.isItalic()) span.italic = true;
	if (at.isUnderline()) span.underline = true;
	if (at.isStrikethrough()) span.strike = true;
	if (at.isInverse()) span.inverse = true;
	return span;
}

function colorOf(isDefault: boolean, isPalette: boolean, value: number): HistoryColor | undefined {
	if (isDefault) return undefined;
	return isPalette ? { kind: 'palette', index: value } : { kind: 'rgb', value };
}

function sameStyle(a: HistorySpan | null, b: HistorySpan | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		sameColour(a.fg, b.fg) &&
		sameColour(a.bg, b.bg) &&
		a.bold === b.bold &&
		a.dim === b.dim &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.strike === b.strike &&
		a.inverse === b.inverse
	);
}

function sameColour(a: HistoryColor | undefined, b: HistoryColor | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.kind !== b.kind) return false;
	return a.kind === 'palette'
		? a.index === (b as { index: number }).index
		: a.value === (b as { value: number }).value;
}

/**
 * Two rows that were one line. A trailing trim already ran on the first half, so the
 * padding a wrap never had is not re-introduced here.
 */
function joinLines(first: HistoryLine, second: HistoryLine): HistoryLine {
	if (typeof first === 'string' && typeof second === 'string') return first + second;
	const spans = typeof first === 'string' ? [{ text: first }] : first;
	const rest = typeof second === 'string' ? [{ text: second }] : second;
	return [...spans, ...rest];
}

/** The plain text of a line, without importing core at runtime (see the type import). */
function plainOf(line: HistoryLine): string {
	if (typeof line === 'string') return line;
	let out = '';
	for (const span of line) out += span.text;
	return out;
}

/**
 * Is this a Mac, by the same signal xterm uses?
 *
 * ⚠ `navigator.platform`, NOT the user agent — and the difference is not academic. The
 * first attempt to reproduce the macOS behaviour overrode only the UA, watched Shift+drag
 * work, and concluded the platform was fine. It had measured Linux twice. xterm reads
 * `platform` against a fixed list, so anything checking this has to read the same thing.
 */
export function macPlatform(navigatorLike: { platform?: string } | undefined = globalThis.navigator): boolean {
	return ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(navigatorLike?.platform ?? '');
}

/** The sliver of a terminal this needs, so the rule can be tested without a canvas. */
export interface SelectionSource {
	getSelection(): string;
}

/**
 * Releasing a selection puts it on the clipboard — tmux, iTerm2, PuTTY and every X11
 * terminal have always done this, and it is what "select and copy" means to anybody who
 * has used one.
 *
 * THE REPORT WAS "dragging does not copy". Two separate things
 * were missing and this is the second: even once a drag reached xterm (the click guard
 * used to occlude the surface and eat it), the selection just sat there. The only copy
 * path was a keyboard shortcut, and a shortcut you have to already know about is not an
 * answer to "I selected it and nothing happened".
 *
 * ⚠ DRIVEN BY `onSelectionChange`, NOT BY A `pointerup` OF OUR OWN. That was the first
 * attempt and it was wrong in four ways, all of which this avoids:
 *
 *   - xterm settles a selection on a `mouseup` bound to the DOCUMENT, so a listener on the
 *     pane read the state from before the release and had to defer a frame to compensate —
 *     which moved the clipboard write out of the user gesture. Safari refuses that outright.
 *   - dragging PAST the pane edge is the ordinary way to select to end of line, and that
 *     release never lands on the pane at all.
 *   - a deferred callback can outlive `dispose()` and touch a disposed terminal.
 *   - double- and triple-click select through the same path and would have needed their own
 *     handling.
 *
 * xterm fires this once per settled change (it compares against the previous range and
 * stays quiet when nothing moved), synchronously inside its own mouseup — so this runs
 * inside the gesture, exactly once, however the selection was made.
 *
 * ⚠ AN EMPTY SELECTION IS LEFT ALONE. A plain click clears the selection and fires this
 * too; writing "" then would silently wipe whatever the user had on their clipboard,
 * trading this fix for a far more annoying bug. Same for the buffer swapping when a
 * multiplexer enters or leaves its alternate screen.
 *
 * ⚠ AND THERE IS DELIBERATELY NO "SAME TEXT, SKIP IT" GUARD. One was written, as belt and
 * braces against a re-fire, and it broke re-selection outright: xterm does not always
 * announce the clear between two selections, so selecting the SAME line a second time
 * matched the remembered value and copied nothing. Measured in a browser — Option+drag
 * stopped working purely because Shift+drag had just copied that line. Writing the same
 * string to the clipboard twice costs nothing; refusing to costs the user their copy.
 */
export function selectionCopier(term: SelectionSource, copy: (text: string) => void | Promise<void>): () => void {
	return () => {
		const selection = term.getSelection();
		if (!selection) return;
		void copy(selection);
	};
}

export const createXtermSurface: TerminalSurfaceFactory = async (host: HTMLElement) => {
	const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
	const { terminalKeyAction, TERMINAL_NEWLINE } = await import('@pdmux/core');
	const term = new Terminal({
		convertEol: false,
		cursorBlink: true,
		fontSize: TERMINAL_FONT_SIZE,
		scrollback: 5000,
		/**
		 * ⚠ WITHOUT THIS, A MAC CANNOT SELECT A TERMINAL THAT REPORTS THE MOUSE — at all.
		 *
		 * When a program turns on mouse reporting (tmux with `mouse on`, vim, and every
		 * coding agent that draws its own UI) xterm forwards the drag to the program
		 * instead of selecting. The documented escape is a modifier, and xterm's rule is
		 * `isMac ? altKey && macOptionClickForcesSelection : shiftKey` — so on a Mac Shift
		 * is ignored outright and Option only works if this is on. It is off by default,
		 * which left Mac users with no gesture at all.
		 *
		 * It cannot be made Shift on a Mac: that branch is hardcoded in xterm. Option+drag
		 * there, Shift+drag everywhere else.
		 */
		macOptionClickForcesSelection: true,
		// The pane is resized by CSS, so the terminal must never impose its own size.
		theme: TERMINAL_THEME,
	});
	// --- what you select is what you copy -------------------------------------
	const selectionSub = term.onSelectionChange(selectionCopier(term, writeClipboard));

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	term.open(host);
	fitAddon.fit();

	/**
	 * On a Mac, make SHIFT force a selection too — because every terminal that Mac user
	 * has ever used does.
	 *
	 * REPORTED, and then measured in a real browser on both platforms: with a program
	 * reporting the mouse (tmux, or a coding agent drawing its own UI), Shift+drag copies
	 * on Linux/Windows and does NOTHING on macOS, where only Option+drag works. The
	 * reporter's own words were that in a native terminal they "shift+drag, then Cmd+C" —
	 * so the gesture they reach for is Shift, and in pdmux it silently went to the program.
	 *
	 * ⚠ THIS IS AN XTERM-ISM, NOT A MAC CONVENTION. xterm hardcodes
	 * `isMac ? altKey && macOptionClickForcesSelection : shiftKey` and there is no option
	 * to change it. Terminal.app and iTerm2 both use Shift. So the modifier is translated
	 * here, at the only point the decision is made — `mousedown`. Everything after it
	 * (the drag, the release, the copy) is xterm's ordinary forced-selection path.
	 *
	 * ⚠ ONLY WHILE THE PROGRAM IS REPORTING THE MOUSE. With reporting off, a plain drag
	 * already selects and Shift means something else entirely — xterm uses shift+click to
	 * EXTEND an existing selection, and translating it would break that for no gain.
	 *
	 * The synthetic event carries `altKey` as well as `shiftKey`, which is also what stops
	 * this recursing: the condition below cannot match its own dispatch.
	 */
	if (macPlatform()) {
		host.addEventListener(
			'mousedown',
			(event: MouseEvent) => {
				if (event.button !== 0 || !event.shiftKey || event.altKey) return;
				if (term.modes.mouseTrackingMode === 'none') return;
				const target = event.target;
				if (!(target instanceof HTMLElement)) return;
				event.preventDefault();
				event.stopPropagation();
				target.dispatchEvent(
					new MouseEvent('mousedown', {
						bubbles: true,
						cancelable: true,
						composed: true,
						view: event.view,
						button: event.button,
						buttons: event.buttons,
						clientX: event.clientX,
						clientY: event.clientY,
						screenX: event.screenX,
						screenY: event.screenY,
						detail: event.detail,
						ctrlKey: event.ctrlKey,
						metaKey: event.metaKey,
						shiftKey: true,
						altKey: true,
					}),
				);
			},
			true,
		);
	}

	// Keys the terminal must answer itself rather than leaving to the browser: the
	// copy shortcuts (which quietly do nothing when the keystroke lands outside the
	// terminal) and Shift+Enter (which the wire cannot distinguish from Enter). See
	// @pdmux/core/terminal-keys for why, including what is deliberately NOT claimed.
	term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
		const action = terminalKeyAction(event);
		if (action === 'copy') {
			const selection = term.getSelection();
			if (!selection) return true; // nothing to copy: let the key be
			event.preventDefault();
			event.stopPropagation();
			void writeClipboard(selection);
			return false;
		}
		if (action === 'newline') {
			event.preventDefault();
			event.stopPropagation();
			term.input(TERMINAL_NEWLINE);
			return false;
		}
		return true;
	});


	// --- IME: send the composed syllable, never the jamo ----------------------
	/**
	 * REPORTED FROM A PHONE: typing Korean produced the three separate letters of a
	 * syllable instead of the syllable, which makes
	 * the terminal unusable in any composing language (Korean, Japanese, Chinese).
	 *
	 * THE CAUSE, read out of xterm's own source: its `input` handler sends whenever
	 * `inputType === 'insertText'` and **does not look at `isComposing`**. On a desktop
	 * IME the browser reports `insertCompositionText` while composing, so the bug never
	 * fires there; iOS (and some Android keyboards) report `insertText` for every marked-text
	 * change, so each jamo went straight to the PTY — and then `compositionend` sent the
	 * finished syllable on top of them.
	 *
	 * The guard sits on the HOST element in the capture phase, which is what makes it work:
	 * xterm's listener is on the textarea itself, and an ancestor's capture listener runs
	 * before the target's. Stopping propagation there means xterm never sees the
	 * intermediate events, while `compositionstart`/`compositionupdate` still reach it so
	 * its composing preview keeps working.
	 */
	let composing = false;
	let lastEmit = 0;
	const emitters = new Set<(data: string) => void>();
	const emit = (data: string): void => {
		lastEmit = Date.now();
		for (const listener of emitters) listener(data);
	};

	host.addEventListener(
		'input',
		(event: Event) => {
			if ((event as InputEvent).isComposing || composing) event.stopPropagation();
		},
		true,
	);
	host.addEventListener('compositionstart', () => (composing = true), true);
	host.addEventListener(
		'compositionend',
		(event: Event) => {
			composing = false;
			const text = (event as CompositionEvent).data ?? '';
			if (!text) return;
			const before = lastEmit;
			/**
			 * xterm finalises its own composition on a 0ms timeout and sends the syllable, so
			 * the normal path needs nothing from us. This is the safety net for a browser that
			 * fires composition events but leaves xterm's textarea empty: if nothing was sent
			 * shortly after the commit, send it ourselves. Guarded by the emit timestamp so the
			 * two paths can never both deliver the same syllable.
			 */
			setTimeout(() => {
				if (lastEmit === before) emit(text);
			}, 120);
		},
		true,
	);

	// --- Touch: BE the wheel, because a phone does not have one ----------------
	/**
	 * REPORTED FROM A PHONE, TWICE. First: a mouse wheel reaches earlier output, a finger drag
	 * does not. Then, after that fix shipped: from an iPhone, a pane running a coding agent
	 * still would not scroll, and the operator had to go back to a desktop to read what the
	 * agent had done while they were away.
	 *
	 * THE FIRST FIX WAS RIGHT ABOUT THE ASYMMETRY AND WRONG ABOUT THE REMEDY. xterm handles
	 * both gestures, but not the same way (`Terminal.ts`, 5.5.0):
	 *
	 *  - `touchstart`/`touchmove` call `Viewport.handleTouch*`, which does
	 *    `viewportElement.scrollTop += deltaY` — it can only ever move xterm's OWN viewport —
	 *    and both listeners stand down entirely while the program is capturing the pointer
	 *    (`if (!this.coreMouseService.areMouseEventsActive)`).
	 *  - the `wheel` listener re-decides between THREE answers on every single event: a mouse
	 *    report for a program that asked for one, else `ESC[A`/`ESC[B` for a buffer that keeps
	 *    no scrollback, else xterm's own viewport.
	 *
	 * So the first fix hand-rolled the middle answer for a drag, and with it inherited a copy
	 * of xterm's stand-down — because a touch produces no mouse report to hand over. That is
	 * exactly the case this product is nearly always in: a pane pointed at a session runs
	 * `tmux new -A -s <name>` in the ALTERNATE buffer, where xterm keeps no scrollback at all
	 * (`common/buffer/BufferSet.ts:44` constructs it with `hasScrollback = false`, which
	 * `Buffer.ts:92` then returns; measured on such a pane, `scrollHeight` 579 and
	 * `clientHeight` 579), AND the coding agent inside it captures the mouse. Measured on the
	 * reported host: `#{alternate_on}` 1, `cmd=claude`. Both touch paths were empty at the same
	 * time — xterm's and ours — while the ⇞/⇟ buttons kept working, because those had already
	 * stopped deciding and started DISPATCHING A WHEEL (see `spinWheel` below).
	 *
	 * A GESTURE MUST NOT CARRY A SECOND COPY OF THAT ROUTING. So this one does what the buttons
	 * do: it turns finger travel into wheel notches and lets xterm answer. All three cases come
	 * back for free, including the reported one, and there is no longer a decision here to
	 * drift out of step with xterm's.
	 *
	 * ⚠ THE PRICE OF DROPPING THE `alternate` GUARD IS `scrollback: 5000` ABOVE. On the normal
	 * buffer `hasScrollback` is `maxLength > rows` (`Buffer.ts:91`) and `maxLength` is
	 * `rows + scrollback`, so it is true even on an empty buffer: a wheel there can only reach
	 * the viewport, never the cursor-key branch. Set `scrollback` to `rows` or less and a drag
	 * at a shell prompt would start recalling shell history instead. The two numbers are one
	 * decision, and a spec pins it.
	 *
	 * HOW IT IS BOUNDED — it must not steal a gesture from anything else on the screen:
	 *  - bubble phase on the HOST, so xterm's own listeners on `.xterm` run first; a move it
	 *    already consumed arrives with `defaultPrevented` and is left alone. Never two scrolls.
	 *    Measured on a shell pane after `seq 1 500`: xterm's own handler moved `scrollTop`
	 *    7131 -> 6991 and cancelled every move, which is precisely the signal read here
	 *    (`Viewport.ts` `_bubbleScroll` calls `preventDefault` only when it really scrolled).
	 *  - single touch only, and the axis is LOCKED on first real movement: a horizontal drag is
	 *    released for good, and THAT is what keeps the browser's edge/back swipe — a
	 *    `touch-action` declaration could not, because that gesture is the browser's own.
	 *  - `preventDefault` happens ONLY on a move this actually consumed. A tap never reaches
	 *    the threshold, so click synthesis (tap-to-focus, which raises the keyboard) is intact,
	 *    and the page's `overscroll-behavior: none` still owns everything this declines.
	 *  - the pane header (drag-to-reorder), the key bar and the composer are all OUTSIDE this
	 *    element, so none of their `pointerdown` handling is touched.
	 *
	 * ⚠ ONE THING IS DELIBERATELY LOST. On a mouse-capturing pane a drag past the axis lock used
	 * to reach the program as a synthesized CLICK — iOS makes `mousedown`/`mouseup` out of a
	 * touch and xterm encodes a button report — because this code stood down and left that
	 * synthesis alone. Consumed moves are cancelled now, so the click is gone. A TAP still
	 * clicks, which is the gesture that meant to.
	 */
	/** Finger travel, in px, before the gesture commits to an axis. */
	const AXIS_LOCK_PX = 8;
	/**
	 * A fling must not become a page-long jump: one move event is worth at most this much finger
	 * travel, counted in ROWS rather than notches so the ceiling does not move when the notch
	 * does. Twelve rows is about half a phone pane, and it is what stops a discontinuity — the
	 * keyboard opening, a rotation, a pane re-fit — from arriving as one enormous jump.
	 */
	const MAX_ROWS_PER_MOVE = 12;
	/**
	 * One notch, in lines. Three is what a mouse reports and what `vim` assumes of one.
	 *
	 * Shared vocabulary: the finger below, the two scroll buttons and the Shift+wheel fallback
	 * all measure in this unit, so a pane answers a drag and a button press at the same scale.
	 */
	const WHEEL_NOTCH_LINES = 3;
	/**
	 * How far the finger travels per notch, in rows — and it depends on WHO ANSWERS THE WHEEL,
	 * because their answers are different sizes.
	 *
	 * ⚠ REPORTED FROM AN IPHONE AFTER THE GESTURE STARTED WORKING: "it scrolls far too slowly."
	 * The gesture emitted one notch per three rows of travel, which tracks the finger exactly
	 * while xterm is the one answering — its cursor-key fallback and its own viewport both move
	 * WHEEL_NOTCH_LINES per notch, so three rows of finger buy three lines of output.
	 *
	 * A program holding the mouse is a different bargain. A mouse report carries no magnitude, so
	 * how far one notch scrolls is entirely that program's choice — and a coding agent's TUI
	 * moves much less than three lines for it. Three rows of travel then bought a fraction of a
	 * screen, which is what the report was about. One row per notch is the closest this code can
	 * get to "the content follows the finger" without knowing what the program will do.
	 *
	 * ⚠ AND IT CANNOT BE EXACT, BY CONSTRUCTION. A multiplexer in copy-mode moves several lines
	 * per report; such a pane is now faster than the finger rather than slower. There is no
	 * feedback channel to calibrate against — the program never says how far it went — so this is
	 * a choice about which case to be right for, and the reported one wins.
	 */
	const notchRows = (): number => (term.modes.mouseTrackingMode !== 'none' ? 1 : WHEEL_NOTCH_LINES);

	/**
	 * MOMENTUM — the flick keeps going after the finger leaves.
	 *
	 * ⚠ REPORTED FROM A PHONE, THIRD ROUND: with the scale already matched to the finger, reaching
	 * an hour of transcript is still an hour of dragging. One-to-one is the right answer for
	 * placing the view and the wrong one for travelling, which is why every touch platform ships
	 * both — and asking for a coding agent's earlier output is travelling.
	 *
	 * The physics is the ordinary one: velocity is measured over the last moves, and after the
	 * release it decays exponentially while the same notch machinery below turns the distance into
	 * wheel events. Nothing here knows how far a notch actually moves the program (it never says),
	 * so this is bounded twice — a ceiling per fling and a per-frame cap — rather than trusted.
	 *
	 * ⚠ A NEW TOUCH STOPS IT. That is what makes a fling safe to be generous with: the way out of
	 * an overshoot is to put a finger down, the same as every scroll view.
	 */
	/** Below this (px per ms) a release was a deliberate stop, not a flick. */
	const FLING_MIN_VELOCITY = 0.25;
	/** Where the animation gives up rather than crawling. */
	const FLING_STOP_VELOCITY = 0.02;
	/**
	 * Velocity kept per millisecond, and how much of the finger's own speed a flick is worth.
	 *
	 * ⚠ MEASURED AGAINST THE COMPLAINT, NOT CHOSEN FROM A PHYSICS TABLE. At 0.998 with no boost a
	 * normal flick reached 44 notches and a hard one 112 (20px rows, one row per notch — the scale
	 * a mouse-capturing program gets). The report that started this round was that reaching an
	 * hour of transcript takes an hour, so both were raised until a hard flick crosses a few
	 * screens and a chain of them crosses many.
	 *
	 * The boost is not physics: a flick is a REQUEST TO TRAVEL, and how fast the finger happened
	 * to be moving under-states how far the person wants to go. Every scroll view on every
	 * platform has the same fudge factor, for the same reason.
	 */
	const FLING_DECAY_PER_MS = 0.999;
	const FLING_BOOST = 1.4;
	/** A ceiling on one fling, so an unknown program cannot be sent a thousand reports. */
	const FLING_MAX_NOTCHES = 400;
	/**
	 * ⚠ FLICKS COMPOUND, WITHIN A WINDOW. Repeating the gesture is how anyone asks for "further",
	 * and starting each one from zero is what makes a long journey feel like work. A second flick
	 * in the same direction within this window keeps half of what was left of the first.
	 */
	const FLING_CHAIN_MS = 300;
	/** How much of the interrupted fling a chained one inherits. */
	const FLING_CHAIN_SHARE = 0.5;

	let armed = false;
	let axis: 'none' | 'x' | 'y' = 'none';
	let lastX = 0;
	let lastY = 0;
	/** Sub-notch remainder, so slow drags still add up instead of being rounded away. */
	let carry = 0;
	/** When the last move was seen, for the velocity the release needs. */
	let lastAt = 0;
	/** Finger speed, px per ms, smoothed — positive is downward, like `dy`. */
	let velocity = 0;
	/** The running fling's timer handle, and what it was doing when a finger interrupted it. */
	let flingHandle: number | null = null;
	let flingVelocity = 0;
	let flingStoppedAt = 0;
	let flingStoppedVelocity = 0;

	/** Height of one row, from the box actually on screen. */
	const rowHeight = (): number => {
		const rows = term.rows;
		const height = term.element?.clientHeight ?? host.clientHeight;
		return rows > 0 && height > 0 ? height / rows : 0;
	};

	/** `performance.now()` where there is one; a fake clock in a test has both. */
	const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

	const nextFrame = (fn: (at: number) => void): number =>
		typeof requestAnimationFrame === 'function'
			? requestAnimationFrame(fn)
			: (setTimeout(() => fn(now()), 16) as unknown as number);

	const cancelFrame = (handle: number): void => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
		else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
	};

	/**
	 * Turn a distance in pixels into wheel notches, carrying the remainder.
	 *
	 * Shared by the drag and the fling so both answer at the same scale, and so the cap means the
	 * same thing in both: at most `MAX_ROWS_PER_MOVE` rows of travel per event or per frame.
	 */
	const consume = (distance: number): number => {
		const rows = notchRows();
		const notch = rowHeight() * rows;
		if (notch <= 0) return 0;
		carry += distance;
		const notches = Math.trunc(carry / notch);
		if (notches === 0) return 0;
		carry -= notches * notch;
		const cap = Math.max(1, Math.floor(MAX_ROWS_PER_MOVE / rows));
		const count = Math.min(Math.abs(notches), cap);
		// A finger travelling DOWN pulls earlier output down into view, which is a wheel turned
		// BACK — the same direction the ⇞ button asks for.
		spinWheel(notches > 0 ? -1 : 1, count);
		return count;
	};

	const stopFling = (): void => {
		if (flingHandle === null) return;
		cancelFrame(flingHandle);
		flingHandle = null;
		// Remember what it was doing: a second flick within the chain window inherits some of it.
		flingStoppedAt = now();
		flingStoppedVelocity = flingVelocity;
		flingVelocity = 0;
	};

	const startFling = (initial: number): void => {
		stopFling();
		flingVelocity = initial;
		carry = 0;
		let spent = 0;
		let previous = now();
		const step = (at: number): void => {
			flingHandle = null;
			const dt = at - previous;
			previous = at;
			/**
			 * ⚠ A DROPPED FRAME IS NOT DISTANCE. A backgrounded tab stops getting frames and
			 * resumes with a gap of seconds; multiplying that by the velocity would deliver the
			 * whole fling at once, to a program that has been idle the entire time.
			 */
			if (dt <= 0 || dt > 100) {
				previous = at;
				flingHandle = nextFrame(step);
				return;
			}
			spent += consume(flingVelocity * dt);
			flingVelocity *= Math.pow(FLING_DECAY_PER_MS, dt);
			if (Math.abs(flingVelocity) < FLING_STOP_VELOCITY || spent >= FLING_MAX_NOTCHES) {
				flingVelocity = 0;
				return;
			}
			flingHandle = nextFrame(step);
		};
		flingHandle = nextFrame(step);
	};

	const listeners: (() => void)[] = [];
	const listen = <K extends keyof HTMLElementEventMap>(
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
		options: AddEventListenerOptions,
	): void => {
		host.addEventListener(type, handler as EventListener, options);
		listeners.push(() => host.removeEventListener(type, handler as EventListener, options));
	};



	const release = (): void => {
		armed = false;
		axis = 'none';
		carry = 0;
		velocity = 0;
	};

	listen(
		'touchstart',
		(event: TouchEvent) => {
			const touch = event.touches.length === 1 ? event.touches[0] : undefined;
			if (!touch) {
				release();
				return;
			}
			// A finger down stops the fling, the way it does in every scroll view — and that is
			// what makes a generous fling safe: overshooting is undone by touching the screen.
			stopFling();
			armed = true;
			axis = 'none';
			carry = 0;
			velocity = 0;
			lastAt = event.timeStamp || now();
			lastX = touch.clientX;
			lastY = touch.clientY;
		},
		{ passive: true },
	);

	listen(
		'touchmove',
		(event: TouchEvent) => {
			if (!armed || event.touches.length !== 1) return;
			// xterm moved its own viewport and said so by cancelling the event.
			if (event.defaultPrevented) return;
			const touch = event.touches[0];
			const dx = touch.clientX - lastX;
			const dy = touch.clientY - lastY;
			if (axis === 'none') {
				if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
				axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
			}
			lastX = touch.clientX;
			lastY = touch.clientY;
			if (axis !== 'y') return;
			/**
			 * Speed, for the fling the release may start. Smoothed rather than taken from the last
			 * move alone: a finger leaving the glass often reports one short move, and a raw
			 * reading there turns a fast flick into a dead stop.
			 */
			const at = event.timeStamp || now();
			const elapsed = at - lastAt;
			if (elapsed > 0) velocity = elapsed < 100 ? 0.7 * (dy / elapsed) + 0.3 * velocity : dy / elapsed;
			lastAt = at;
			// `consume` is shared with the fling, so both scale a distance the same way — including
			// asking `notchRows()` again, because a program turns mouse reporting on and off.
			if (consume(dy) === 0) return;
			if (event.cancelable) event.preventDefault();
		},
		{ passive: false },
	);

	listen(
		'touchend',
		(event: TouchEvent) => {
			const flick = axis === 'y' && Math.abs(velocity) >= FLING_MIN_VELOCITY;
			if (flick) {
				/**
				 * A second flick in the same direction, soon after one was interrupted, keeps part
				 * of what that one had left. Chaining is how a person asks for "further" — starting
				 * every flick from zero is what makes a long journey feel like work.
				 */
				const chained =
					Math.sign(velocity) === Math.sign(flingStoppedVelocity) &&
					(event.timeStamp || now()) - flingStoppedAt < FLING_CHAIN_MS
						? flingStoppedVelocity * FLING_CHAIN_SHARE
						: 0;
				startFling((velocity + chained) * FLING_BOOST);
			}
			release();
		},
		{ passive: true },
	);
	listen(
		'touchcancel',
		() => {
			// Cancelled is not released: the system took the gesture away, so nothing was meant.
			stopFling();
			release();
		},
		{ passive: true },
	);

	// --- The one wheel path: BE the wheel rather than guess what it would have done -------
	/**
	 * REPORTED FROM A PHONE: the two scroll buttons do nothing, and vanish on the tap.
	 *
	 * This is where the answer was found first, and the finger above now comes through here
	 * too — the buttons and the drag are two ways of asking for the same notch.
	 *
	 * The vanishing was a latch (`canScroll` below, and `TerminalPane`). The doing nothing was
	 * this: the buttons called `term.scrollPages()`, which moves xterm's OWN viewport and
	 * nothing else. A pane attached to a multiplexer runs in the ALTERNATE buffer, where that
	 * viewport has nowhere to go — so on the panes this dashboard is nearly always showing,
	 * the call was a no-op by construction.
	 *
	 * ⚠ AND A KEY IS NOT A SUBSTITUTE. The obvious repair is to send PageUp/PageDown, the keys
	 * the ⇞/⇟ glyphs name. It fails on the programs this product exists to watch. A coding
	 * agent's TUI draws on the alternate screen AND captures the mouse, and then it is the
	 * WHEEL that moves its transcript — measured by the user on a real phone: the wheel reaches
	 * earlier output, PageUp does not. The vendor documentation says the same of its fullscreen
	 * renderer ("Mouse wheel scrolling requires your terminal to forward mouse events to" it),
	 * and a multiplexer with `mouse on` wants the same report. Different programs answer to
	 * different things, and no single KEY reaches all of them.
	 *
	 * So this decides nothing. It DISPATCHES A WHEEL EVENT at the terminal, and xterm's own
	 * handler routes it exactly as it routes a real one (`@xterm/xterm` 5.5.0, `Terminal.ts`):
	 *
	 *   1. the program asked for wheel mouse reports → encode one in its protocol (`:704`)
	 *   2. else the buffer keeps no scrollback       → `ESC[A`/`ESC[B` for the program (`:809`)
	 *   3. else                                      → scroll xterm's viewport (`:830`)
	 *
	 * That is the whole point. Those three cases are xterm's to know; it re-reads them on EVERY
	 * event, which matters because a program turns mouse reporting on and off mid-session; and
	 * a copy of the routing here would be a second opinion that drifts. It is also exactly what
	 * the same problem needed elsewhere — a terminal multiplexer solving it for its own panes
	 * landed on per-event routing on the same three facts, having started from a latch.
	 */
	/**
	 * Turn the wheel `notches` times.
	 *
	 * ⚠ NOTCHES, NOT ONE LARGE EVENT. A mouse report carries no magnitude — case 1 above reads
	 * `deltaY` only to check that it is non-zero — so a single event scrolls a capturing program
	 * by one notch however big the delta is. The count is therefore the whole message.
	 *
	 * ⚠ DECLARED WITH `function` SO IT HOISTS. The touch handler above is the other caller and
	 * it is installed first; a `const` here would be a forward reference that only works by
	 * accident of when events fire.
	 */
	function spinWheel(direction: -1 | 1, notches: number): void {
		const element = term.element;
		if (!element) return;
		// The screen element is what xterm measures a mouse report against, and both wheel
		// listeners sit on its parent — so a bubbling event from its middle is routed AND
		// reported at a cell that exists.
		const target = (element.querySelector('.xterm-screen') as HTMLElement | null) ?? element;
		const box = target.getBoundingClientRect();
		for (let notch = 0; notch < notches; notch += 1) {
			target.dispatchEvent(
				new WheelEvent('wheel', {
					bubbles: true,
					cancelable: true,
					// LINES, not pixels: a pixel delta is divided by a row height xterm measures
					// on the canvas, and the remainder is carried between events rather than used.
					deltaMode: WheelEvent.DOM_DELTA_LINE,
					deltaY: direction * WHEEL_NOTCH_LINES,
					clientX: box.left + box.width / 2,
					clientY: box.top + box.height / 2,
				}),
			);
		}
	}

	/** A page, in the notches a hand would have had to spin for it. */
	const pageNotches = (): number => Math.max(1, Math.ceil(Math.max(1, term.rows - 1) / WHEEL_NOTCH_LINES));

	// --- Shift+wheel: take the wheel back from the program ---------------------
	/**
	 * REPORTED: one pane scrolls with the wheel and another does not, both running a
	 * coding agent under the same multiplexer.
	 *
	 * ⚠ NEITHER PANE IS BEHAVING INCORRECTLY, WHICH IS WHY NOTHING HERE CHANGES THE
	 * PLAIN WHEEL. When a program turns on mouse tracking, xterm encodes the wheel as a
	 * report for it and skips its own scrollback and cursor-key fallbacks outright
	 * (`Terminal.ts`: `if (requestedEvents.wheel) return`). From there the gesture means
	 * whatever the program decides — one moves its transcript, another ignores it. The
	 * one that works today is working BECAUSE the wheel reaches it, so hijacking the
	 * plain wheel would fix one pane by breaking the other, and would also take away
	 * every legitimate mouse use (menus, selection) a full-screen program has.
	 *
	 * So the escape hatch is SHIFT, which is what terminal emulators have used for this
	 * exact standoff for years: hold it and the wheel belongs to the terminal again.
	 *
	 * `attachCustomWheelEventHandler` is the only seam that can do this, because xterm
	 * consults it on BOTH wheel paths — the mouse-report one and the fallback one.
	 * Returning `false` is what keeps the report off the wire.
	 */
	const scrollbackWanted = new Set<(direction: -1 | 1) => void>();

	term.attachCustomWheelEventHandler((event: WheelEvent): boolean => {
		if (!event.shiftKey || event.deltaY === 0) return true;
		const direction: -1 | 1 = event.deltaY < 0 ? -1 : 1;

		if (term.buffer.active.type !== 'alternate') {
			/**
			 * A plain shell: xterm is holding the history itself, so scroll it HERE rather
			 * than returning `true`. Handing the event back would be no use — a program
			 * that captured the mouse has already caused the fallback branch to be skipped,
			 * and that branch is the one that would have scrolled.
			 */
			const height = rowHeight();
			const lines =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? Math.round(event.deltaY)
					: height > 0
						? Math.round(event.deltaY / height)
						: 0;
			term.scrollLines(lines || direction * WHEEL_NOTCH_LINES);
			return false;
		}

		/**
		 * The alternate buffer, which is where a multiplexer pane always is: xterm keeps
		 * NO scrollback here, so there is nothing local to move — the history is the
		 * multiplexer's and only it can show it. Say so upward and swallow the event; the
		 * consumer owns the network and decides what to ask for.
		 */
		for (const listener of scrollbackWanted) listener(direction);
		return false;
	});

	const sub = term.onData((data) => emit(data));

	return {
		write: (data) => term.write(data),
		onScrollbackRequest: (listener) => {
			scrollbackWanted.add(listener);
			return () => scrollbackWanted.delete(listener);
		},
		fit: () => {
			fitAddon.fit();
			return { cols: term.cols, rows: term.rows };
		},
		focus: () => term.focus(),
		onData: (listener) => {
			emitters.add(listener);
			return () => emitters.delete(listener);
		},
		scrollPages: (delta) => spinWheel(delta < 0 ? -1 : 1, pageNotches()),
		/**
		 * Whether a wheel would reach anything here — the three cases in `spinWheel`, in order.
		 *
		 * ⚠ NEVER CACHE THIS. A pane enters and leaves the alternate buffer and turns mouse
		 * reporting on and off while it runs, so the answer is only true of the moment it was
		 * asked. Keeping it is how the buttons came to disappear on the very tap they existed
		 * to serve: the one caller was the press itself.
		 */
		canScroll: () =>
			term.modes.mouseTrackingMode !== 'none' ||
			term.buffer.active.type === 'alternate' ||
			term.buffer.active.baseY > 0,
		readHistory: () => {
			const buffer = term.buffer.active;
			const scrollback = buffer.type !== 'alternate';
			const lines: HistoryLine[] = [];
			/**
			 * ⚠ ONE CELL OBJECT FOR THE WHOLE WALK. `getCell(x, cell)` fills the one it is
			 * given; calling it without one allocates per cell, and a 5000-line buffer at
			 * 200 columns is a million allocations for a button press.
			 */
			const cell = buffer.getNullCell();
			for (let index = 0; index < buffer.length; index++) {
				const line = buffer.getLine(index);
				const read = line ? readLine(line, cell) : '';
				/**
				 * ⚠ A WRAPPED ROW IS NOT A LINE. xterm stores a buffer by rows, so one long
				 * command is already several of them and a sheet that printed each row
				 * separately would carry the PANE's width around forever instead of
				 * reflowing to the reader's. `isWrapped` marks a continuation, and joining
				 * is also what makes a long line long enough to be worth folding. The
				 * remote path asks tmux for the same thing with `capture-pane -J`.
				 */
				if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] = joinLines(lines[lines.length - 1] as HistoryLine, read);
				else lines.push(read);
			}
			// Blank tail lines are the unused part of the buffer, not content.
			while (lines.length > 0 && plainOf(lines[lines.length - 1] as HistoryLine) === '') lines.pop();
			return { lines, scrollback };
		},
		dispose: () => {
			// ⚠ A FLING OUTLIVES THE GESTURE, SO IT CAN OUTLIVE THE SURFACE. Retargeting a pane
			// builds a new surface on the same element; a frame loop still running would be
			// dispatching wheels at a terminal that is gone.
			stopFling();
			sub.dispose();
			selectionSub.dispose();
			emitters.clear();
			// The host OUTLIVES the surface — a pane is created once per slot and retargeting
			// builds a new surface on the same element — so these have to come off by hand.
			for (const off of listeners) off();
			listeners.length = 0;
			term.dispose();
		},
	};
};

/**
 * Put text on the clipboard.
 *
 * `navigator.clipboard` needs a secure context, and a self-hosted deployment is
 * reachable over plain http while it is being set up — losing copy there would be
 * the very bug this code exists to fix, so the old selection-based command is the
 * fallback.
 */
export async function writeClipboard(
	text: string,
	clipboard: Pick<Clipboard, 'writeText'> | null = typeof navigator !== 'undefined' ? navigator.clipboard : null,
): Promise<void> {
	if (clipboard && typeof clipboard.writeText === 'function') {
		try {
			await clipboard.writeText(text);
			return;
		} catch {
			// falls through to the legacy path
		}
	}
	legacyCopy(text);
}

function legacyCopy(text: string): void {
	if (typeof document === 'undefined') return;
	const area = document.createElement('textarea');
	area.value = text;
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.append(area);
	// ⚠ PUT THE FOCUS BACK. Selecting the textarea takes focus off the terminal, and
	// removing it drops focus to `<body>` — so on a plain-http origin (the deployment this
	// fallback exists for) every copy-on-select drag would silently stop the terminal
	// accepting keystrokes. Cheap to restore, invisible when it works.
	const previous = document.activeElement;
	area.select();
	try {
		document.execCommand('copy');
	} finally {
		area.remove();
		if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
	}
}
