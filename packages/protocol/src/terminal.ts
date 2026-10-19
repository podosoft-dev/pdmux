/**
 * Zod-free browser boundary for terminal frames.
 *
 * The canonical server schema remains in the package root. This small entry point
 * exists because browser bundles need to validate four terminal frame shapes but
 * must not pull the complete agent protocol and its Zod graph into SvelteKit SSR.
 */

export const TERMINAL_WS_PATH = '/terminal/ws';

export type TerminalServerFrame =
	| { type: 'ready'; termId: string; pid: number | null; backend?: 'native' | 'tmux'; sessionId?: string }
	| { type: 'screen'; termId: string; data: string; sequence: number; cols: number; rows: number; canvasCols: number; canvasRows: number; x: number; y: number; follow: boolean; alternate?: boolean; history?: number }
	| { type: 'session-result'; termId: string; lines: string[]; screenOnly: boolean; error: string }
	| { type: 'output'; termId: string; data: string; dropped: number }
	| { type: 'exit'; termId: string; code: number | null }
	| { type: 'error'; termId: string; message: string };

export type TerminalServerFrameParseResult =
	| { ok: true; data: TerminalServerFrame }
	| { ok: false; error: string };

function recordOf(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function integerOrNull(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Parse the browser-facing half of the terminal protocol without a runtime dependency. */
export function parseTerminalServerFrame(value: unknown): TerminalServerFrameParseResult {
	const frame = recordOf(value);
	if (!frame) return { ok: false, error: '(root): expected object' };
	if (typeof frame.termId !== 'string') return { ok: false, error: 'termId: expected string' };

	switch (frame.type) {
		case 'ready': {
			const pid = integerOrNull(frame.pid);
			if (pid === undefined) return { ok: false, error: 'pid: expected integer or null' };
			if (frame.backend !== undefined && frame.backend !== 'native' && frame.backend !== 'tmux') return { ok: false, error: 'backend: invalid' };
			if (frame.sessionId !== undefined && (typeof frame.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame.sessionId))) return { ok: false, error: 'sessionId: invalid' };
			return { ok: true, data: { type: 'ready', termId: frame.termId, pid, ...(frame.backend ? { backend: frame.backend } : {}), ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}) } };
		}
		case 'screen': {
            if (frame.alternate !== undefined && typeof frame.alternate !== 'boolean') return { ok: false, error: 'screen.alternate: invalid boolean' };
            if (frame.history !== undefined && (typeof frame.history !== 'number' || !Number.isInteger(frame.history) || frame.history < 0 || frame.history > 5000)) return { ok: false, error: 'screen.history: invalid integer' };
			if (typeof frame.data !== 'string' || frame.data.length > 65536 || typeof frame.follow !== 'boolean') return { ok: false, error: 'screen: invalid payload' };
			for (const [key, low, high] of [['sequence', 0, Number.MAX_SAFE_INTEGER], ['cols', 1, 1000], ['rows', 1, 500], ['canvasCols', 1, 1000], ['canvasRows', 1, 500], ['x', 0, 1000], ['y', 0, 500]] as const) {
				const value = frame[key]; if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) return { ok: false, error: `screen.${key}: invalid integer` };
			}
			return { ok: true, data: { type: 'screen', termId: frame.termId, data: frame.data, follow: frame.follow, sequence: frame.sequence as number, cols: frame.cols as number, rows: frame.rows as number, canvasCols: frame.canvasCols as number, canvasRows: frame.canvasRows as number, x: frame.x as number, y: frame.y as number, ...(typeof frame.alternate === 'boolean' ? { alternate: frame.alternate } : {}), ...(typeof frame.history === 'number' ? { history: frame.history } : {}) } };
		}
		case 'session-result': {
			if (!Array.isArray(frame.lines) || !frame.lines.every(line => typeof line === 'string') || (frame.screenOnly !== undefined && typeof frame.screenOnly !== 'boolean') || (frame.error !== undefined && (typeof frame.error !== 'string' || frame.error.length > 512))) return { ok: false, error: 'session-result: invalid payload' };
			return { ok: true, data: { type: 'session-result', termId: frame.termId, lines: frame.lines as string[], screenOnly: frame.screenOnly === true, error: typeof frame.error === 'string' ? frame.error : '' } };
		}
		case 'output': {
			if (typeof frame.data !== 'string') return { ok: false, error: 'data: expected string' };
			const dropped = frame.dropped ?? 0;
			if (typeof dropped !== 'number' || !Number.isInteger(dropped) || dropped < 0) {
				return { ok: false, error: 'dropped: expected non-negative integer' };
			}
			return { ok: true, data: { type: 'output', termId: frame.termId, data: frame.data, dropped } };
		}
		case 'exit': {
			const code = integerOrNull(frame.code);
			if (code === undefined) return { ok: false, error: 'code: expected integer or null' };
			return { ok: true, data: { type: 'exit', termId: frame.termId, code } };
		}
		case 'error':
			if (typeof frame.message !== 'string' || frame.message.length > 512) {
				return { ok: false, error: 'message: expected string of at most 512 characters' };
			}
			return { ok: true, data: { type: 'error', termId: frame.termId, message: frame.message } };
		default:
			return { ok: false, error: 'type: unknown terminal frame' };
	}
}
