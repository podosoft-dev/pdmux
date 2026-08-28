/**
 * Zod-free browser boundary for terminal frames.
 *
 * The canonical server schema remains in the package root. This small entry point
 * exists because browser bundles need to validate four terminal frame shapes but
 * must not pull the complete agent protocol and its Zod graph into SvelteKit SSR.
 */

export const TERMINAL_WS_PATH = '/terminal/ws';

export type TerminalServerFrame =
	| { type: 'ready'; termId: string; pid: number | null }
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
			return { ok: true, data: { type: 'ready', termId: frame.termId, pid } };
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
