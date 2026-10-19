import { describe, expect, it } from 'vitest';
import { terminalServerFrameSchema } from '../src/index.js';
import { parseTerminalServerFrame } from '../src/terminal.js';

const validFrames: unknown[] = [
	{ type: 'ready', termId: 'term-1' },
	{ type: 'ready', termId: 'term-1', pid: 42 },
	{ type: 'ready', termId: 'term-1', backend: 'native', sessionId: '11111111-2222-4333-8444-555555555555' },
	{ type: 'screen', termId: 'term-1', data: '\x1b[Hhello', sequence: 1, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 60, y: 10, follow: false },
	{ type: 'session-result', termId: 'control-1', lines: ['hello'] },
	{ type: 'session-result', termId: 'control-1', lines: [], error: 'SESSION_NOT_FOUND', screenOnly: true },
	{ type: 'output', termId: 'term-1', data: 'hello' },
	{ type: 'output', termId: 'term-1', data: 'hello', dropped: 4096 },
	{ type: 'exit', termId: 'term-1' },
	{ type: 'exit', termId: 'term-1', code: 130 },
	{ type: 'error', termId: 'term-1', message: 'host offline' },
];

const invalidFrames: unknown[] = [
	null,
	[],
	{ type: 'future', termId: 'term-1' },
	{ type: 'ready' },
	{ type: 'ready', termId: 'term-1', pid: 1.5 },
	{ type: 'ready', termId: 'term-1', backend: 'unknown' },
	{ type: 'ready', termId: 'term-1', sessionId: 'missing' },
	{ type: 'session-result', termId: 'control-1', lines: [42] },
	{ type: 'session-result', termId: 'control-1' },
	{ type: 'screen', termId: 'term-1', data: '', sequence: -1, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 0, y: 0, follow: false },
	{ type: 'output', termId: 'term-1' },
	{ type: 'output', termId: 'term-1', data: 'hello', dropped: -1 },
	{ type: 'exit', termId: 'term-1', code: 1.5 },
	{ type: 'error', termId: 'term-1', message: 'x'.repeat(513) },
];

describe('terminal browser parser', () => {
	it.each(validFrames.map((frame) => [frame] as const))(
		'matches the canonical Zod schema for valid frame %#',
		(frame) => {
			const canonical = terminalServerFrameSchema.safeParse(frame);
			const browser = parseTerminalServerFrame(frame);

			expect(canonical.success).toBe(true);
			expect(browser.ok).toBe(true);
			if (canonical.success && browser.ok) expect(browser.data).toEqual(canonical.data);
		},
	);

	it.each(invalidFrames.map((frame) => [frame] as const))(
		'matches the canonical Zod schema for invalid frame %#',
		(frame) => {
			expect(terminalServerFrameSchema.safeParse(frame).success).toBe(false);
			expect(parseTerminalServerFrame(frame).ok).toBe(false);
		},
	);
});
