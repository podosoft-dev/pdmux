/**
 * A `TerminalAdapter` that replays a RECORDED terminal stream at its original pace.
 *
 * ⚠ THE TRACE IS THE POINT. A synthetic `yes` loop is plain ASCII with no styling and
 * no cursor addressing, so xterm takes its fast path and the benchmark reports a
 * terminal that is not the one anybody is complaining about. The fixture here was
 * captured through a real pty inside tmux — which matters twice over, because tmux
 * does its own redraw optimisation and what reaches a pane is tmux's diff stream, not
 * the program's output.
 *
 * ⚠ AND THE ECHO IS INSTANT, ON PURPOSE. This adapter stands where the network,
 * the API, the agent and the pty would be, and answers in zero time. Whatever
 * latency the bench then measures has only one place left to come from: the browser.
 */
import type {
	TerminalAdapter,
	TerminalConnection,
	TerminalOpenTarget,
} from '../../src/adapters/terminal-adapter.js';

/** One recorded chunk: milliseconds since the recording started, and its bytes. */
export interface TraceChunk {
	t: number;
	d: string;
}

export interface LoadAdapterOptions {
	trace: TraceChunk[];
	/**
	 * Replay speed. The recording is one pane's worth of a busy agent; a fleet where
	 * every pane is busy is the condition being tested, and this is how it is reached
	 * without pretending to have recorded it.
	 */
	rate?: number;
	/** Replay forever, which is what a session a person leaves open looks like. */
	loop?: boolean;
}

/**
 * base64 bytes -> the string the product would deliver.
 *
 * ⚠ `atob` ALONE IS WRONG AND IT LOOKS ALMOST RIGHT. It returns one character per
 * BYTE, so every multi-byte sequence in the recording arrives as its individual
 * Latin-1 bytes: the box-drawing rules in this trace rendered as `â”€` and the pane
 * measured three cells where a terminal draws one. The real path JSON-decodes, which
 * is UTF-8 decoding, so the replay has to decode too.
 */
const utf8 = new TextDecoder('utf-8');
function decodeChunk(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return utf8.decode(bytes, { stream: true });
}

export class TraceReplayAdapter implements TerminalAdapter {
	private readonly trace: TraceChunk[];
	private readonly rate: number;
	private readonly loop: boolean;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(options: LoadAdapterOptions) {
		this.trace = options.trace;
		this.rate = options.rate ?? 1;
		this.loop = options.loop ?? true;
	}

	/** Stop every pane's replay. Without it a spec's next case inherits the last one's load. */
	stop(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}

	open(_target: TerminalOpenTarget): TerminalConnection {
		const data = new Set<(chunk: string) => void>();
		const exit = new Set<(code: number | null) => void>();
		let buffered = '';
		let closed = false;

		const emit = (chunk: string): void => {
			if (!data.size) {
				buffered += chunk;
				return;
			}
			for (const listener of data) listener(chunk);
		};

		const play = (offset: number): void => {
			if (closed) return;
			const first = this.trace[0]?.t ?? 0;
			for (const chunk of this.trace) {
				const at = (chunk.t - first) / this.rate;
				const timer = setTimeout(() => {
					this.timers.delete(timer);
					if (!closed) emit(decodeChunk(chunk.d));
				}, offset + at);
				this.timers.add(timer);
			}
			if (this.loop) {
				const span = ((this.trace[this.trace.length - 1]?.t ?? 0) - first) / this.rate;
				const again = setTimeout(() => {
					this.timers.delete(again);
					play(0);
				}, offset + span + 50);
				this.timers.add(again);
			}
		};
		// Panes are staggered so every terminal on the grid is not painting the same
		// frame — which is the easy way to build a benchmark that only ever measures
		// one thundering herd.
		play(Math.random() * 200);

		return {
			send: (chunk: string): void => {
				if (!closed) emit(chunk);
			},
			resize: (): void => {},
			onData: (listener): (() => void) => {
				data.add(listener);
				if (buffered) {
					const pending = buffered;
					buffered = '';
					listener(pending);
				}
				return () => data.delete(listener);
			},
			onExit: (listener): (() => void) => {
				exit.add(listener);
				return () => exit.delete(listener);
			},
			close: (): void => {
				closed = true;
				data.clear();
				exit.clear();
			},
		};
	}
}
