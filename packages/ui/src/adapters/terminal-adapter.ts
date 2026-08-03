/**
 * The seam between a terminal pane and whatever carries its bytes.
 *
 * WHY AN INTERFACE: transport is an application concern (a WebSocket to a gateway, a
 * local pty, a recorded session for a demo). A component that dialled a socket
 * itself could not be installed anywhere else, and could not be tested without one.
 */

/** What a pane asks for when it mounts. */
export interface TerminalOpenTarget {
	/** Layout slot id — a caller may use it to key its own connections. */
	slotId: string;
	hostId: string;
	kind: 'session' | 'shell';
	/** Session name for `kind: 'session'`; absent for a bare shell. */
	session?: string;
	cols: number;
	rows: number;
}

/** A live terminal. Every listener returns its own unsubscribe. */
export interface TerminalConnection {
	send(data: string): void;
	resize(cols: number, rows: number): void;
	onData(listener: (data: string) => void): () => void;
	onExit(listener: (code: number | null) => void): () => void;
	close(): void;
}

export interface TerminalAdapter {
	open(target: TerminalOpenTarget): TerminalConnection | Promise<TerminalConnection>;
}

/**
 * A self-contained adapter that echoes what it is given.
 *
 * It ships with the package so a pane can be demoed and tested with no server at
 * all — the alternative is a component nobody can render outside the app it came
 * from, which is how UI packages rot.
 */
export class EchoTerminalAdapter implements TerminalAdapter {
	private readonly banner: (target: TerminalOpenTarget) => string;

	constructor(options: { banner?: (target: TerminalOpenTarget) => string } = {}) {
		this.banner =
			options.banner ??
			((target) =>
				`pdmux echo terminal — ${target.kind === 'shell' ? 'shell' : (target.session ?? 'session')}\r\n$ `);
	}

	open(target: TerminalOpenTarget): TerminalConnection {
		const data = new Set<(chunk: string) => void>();
		const exit = new Set<(code: number | null) => void>();
		// Output produced before anyone subscribed. A caller can only attach its
		// listener after `open()` returns, so without this buffer the banner (and
		// anything a real transport replayed on connect) would be lost.
		let buffered = '';
		let closed = false;
		const emit = (chunk: string): void => {
			if (!data.size) {
				buffered += chunk;
				return;
			}
			for (const listener of data) listener(chunk);
		};
		queueMicrotask(() => {
			if (!closed) emit(this.banner(target));
		});
		return {
			send(chunk: string): void {
				if (closed) return;
				// A carriage return is echoed as CRLF, the way a pty in cooked mode does —
				// otherwise every "command" overwrites the previous line.
				emit(chunk === '\r' ? '\r\n$ ' : chunk);
			},
			resize(): void {
				/* nothing to resize: the echo has no remote geometry */
			},
			onData(listener): () => void {
				data.add(listener);
				if (buffered) {
					const pending = buffered;
					buffered = '';
					listener(pending);
				}
				return () => data.delete(listener);
			},
			onExit(listener): () => void {
				exit.add(listener);
				return () => exit.delete(listener);
			},
			close(): void {
				if (closed) return;
				closed = true;
				for (const listener of exit) listener(0);
				data.clear();
				exit.clear();
			},
		};
	}
}
