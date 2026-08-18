/**
 * The pane's surface, built here so the bench can do two things the product's own
 * factory cannot: swap the RENDERER, and say when a byte was actually painted.
 *
 * ⚠ IT DELIBERATELY MIRRORS `createXtermSurface` RATHER THAN WRAPPING IT. That
 * factory owns its `Terminal` and hands back only the `TerminalSurface` methods, so
 * there is no handle to attach `onRender` to and no way to load an addon into it.
 * The constructor options that MATTER for what is being measured — font size, theme,
 * scrollback — are imported from the real module rather than copied, so the numbers
 * describe the product's terminal and not a lookalike.
 *
 * What is left out is deliberate: selection, clipboard, the mouse-wheel routing and
 * the phone gestures. None of them run while output streams, so none of them are on
 * the path this measures.
 */
import type { TerminalSurface, TerminalSurfaceFactory } from '../../src/adapters/terminal-surface.js';
import { TERMINAL_FONT_SIZE, TERMINAL_THEME } from '../../src/adapters/terminal-surface.js';

/**
 * Which renderer to measure. `dom` is what the product ships today.
 *
 * Canvas is deliberately absent: it is a candidate for the FIX (a fallback for a
 * machine with no WebGL), not a question the measurement has to answer.
 */
export type BenchRenderer = 'dom' | 'webgl';

/** One paint, as the bench sees it. */
export interface PaintRecord {
	/** `performance.now()` when xterm finished rendering. */
	at: number;
	/** Rows it repainted — a full-screen redraw and a one-glyph echo are not the same event. */
	rows: number;
}

/**
 * Everything the spec reads, on the window.
 *
 * A side channel rather than a return value because the surface is constructed deep
 * inside `TerminalGrid`, which hands its factory nothing back.
 */
export interface BenchChannel {
	renderer: BenchRenderer;
	/** Whether the requested renderer actually took — WebGL can refuse at runtime. */
	rendererActive: boolean;
	paints: PaintRecord[];
	/**
	 * When the terminal EMITTED the probe keystroke.
	 *
	 * ⚠ STAMPED IN `onData`, NOT BY THE DRIVER. Setting it over CDP just before
	 * pressing the key folds the driver's own round trip into the measurement, and
	 * that round trip is not something the user waits for. `onData` fires
	 * synchronously inside the browser's input handling, so it is the last moment
	 * that is still genuinely the browser's.
	 */
	sentAt: number | null;
	/** send -> painted, one entry per probe. */
	latencies: number[];
	/**
	 * The glyph this probe types.
	 *
	 * ⚠ IT CHANGES EVERY PROBE. A fixed marker stays on screen after the first one
	 * lands, so every later probe finds it already there and reports a latency of
	 * roughly zero — a benchmark that gets faster the longer it runs.
	 */
	marker: string;
}

declare global {
	interface Window {
		__pdmuxBench?: BenchChannel;
	}
}

export function benchChannel(): BenchChannel {
	if (!window.__pdmuxBench) {
		window.__pdmuxBench = {
			renderer: 'dom',
			rendererActive: false,
			paints: [],
			sentAt: null,
			latencies: [],
			marker: '⌘',
		};
	}
	return window.__pdmuxBench;
}

/**
 * ⚠ THE MEASUREMENT IS TAKEN IN `onRender`, NOT AFTER `write()` RETURNS.
 *
 * `write()` only queues: xterm parses on its own schedule and paints on a frame. A
 * timestamp taken when it returns measures the queueing and nothing else — which is
 * exactly the number that stays flat while the screen falls behind, and would have
 * made the DOM renderer look fine.
 */
export function createBenchSurface(renderer: BenchRenderer): TerminalSurfaceFactory {
	return async (host: HTMLElement): Promise<TerminalSurface> => {
		const channel = benchChannel();
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
		]);
		const term = new Terminal({
			convertEol: false,
			cursorBlink: true,
			fontSize: TERMINAL_FONT_SIZE,
			scrollback: 5000,
			theme: TERMINAL_THEME,
		});
		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(host);

		channel.renderer = renderer;
		if (renderer === 'webgl') {
			try {
				// Imported by name so a build that lacks the addon fails loudly here rather
				// than silently measuring the DOM renderer twice and reporting no difference.
				term.loadAddon(new (await import('@xterm/addon-webgl')).WebglAddon());
				channel.rendererActive = true;
			} catch (error) {
				// A machine with no WebGL must not report a comparison it did not make.
				channel.rendererActive = false;
				console.warn(`[bench] ${renderer} renderer unavailable:`, error);
			}
		}
		fitAddon.fit();

		term.onRender((range) => {
			const at = performance.now();
			channel.paints.push({ at, rows: range.end - range.start + 1 });
			// The probe is outstanding and its glyph is now on screen: that is the number.
			if (channel.sentAt !== null && screenHas(term, channel.marker)) {
				channel.latencies.push(at - channel.sentAt);
				channel.sentAt = null;
			}
		});

		return {
			write: (data) => term.write(data),
			fit: () => {
				fitAddon.fit();
				return { cols: term.cols, rows: term.rows };
			},
			focus: () => term.focus(),
			onData: (listener) => {
				const sub = term.onData((data) => {
					if (data.includes(channel.marker)) channel.sentAt = performance.now();
					listener(data);
				});
				return () => sub.dispose();
			},
			scrollPages: (delta) => term.scrollPages(delta),
			canScroll: () => term.buffer.active.type !== 'alternate',
			// The bench measures paint latency, not scrollback: nothing here asks.
			onScrollbackRequest: () => () => undefined,
		onGesture: () => () => undefined,
			readHistory: () => ({ lines: [], scrollback: true }),
			dispose: () => term.dispose(),
		};
	};
}

/** Is the marker anywhere on the visible screen? Cheap enough to run per paint. */
function screenHas(term: { rows: number; buffer: { active: { getLine(y: number): { translateToString(trim?: boolean): string } | undefined; viewportY: number } } }, marker: string): boolean {
	const buffer = term.buffer.active;
	for (let y = 0; y < term.rows; y++) {
		const line = buffer.getLine(buffer.viewportY + y);
		if (line && line.translateToString(true).includes(marker)) return true;
	}
	return false;
}
