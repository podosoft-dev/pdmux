import { describe, expect, it } from 'vitest';
import { terminalClientFrameSchema, terminalServerFrameSchema, agentTerminalAbilitySchema } from '../src/index.js';
import { parseTerminalServerFrame } from '../src/terminal.js';

const validFrames: unknown[] = [
	{ type: 'ready', termId: 'term-1' },
	{ type: 'ready', termId: 'term-1', pid: 42 },
	{ type: 'ready', termId: 'term-1', backend: 'native', sessionId: '11111111-2222-4333-8444-555555555555' },
	{ type: 'screen', termId: 'term-1', data: '\x1b[Hhello', sequence: 1, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 60, y: 10, follow: false },
	{ type: 'screen', termId: 'term-1', data: '', sequence: 2, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 0, y: 0, follow: false, alternate: false, history: 12 },
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
	...['alternate', 'history'].map(key => ({ type: 'screen', termId: 'term-1', data: '', sequence: 1, cols: 40, rows: 12, canvasCols: 120, canvasRows: 40, x: 0, y: 0, follow: false, [key]: 'bad' })),
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

it('[TC-PDUI-237] negotiates rename support without changing old controls or parsing', () => {
 const sessionId = '11111111-2222-4333-8444-555555555555';
 expect(agentTerminalAbilitySchema.parse({}).renameSessions).toBeUndefined();
 expect(agentTerminalAbilitySchema.parse({ renameSessions: true }).renameSessions).toBe(true);
 expect(terminalClientFrameSchema.parse({ type: 'session-control', termId: 'c', action: 'rename', sessionId, name: 'api-work' })).toMatchObject({ name: 'api-work' });
 for (const name of ['bad name', '-'.repeat(33), 'x;kill-session', '']) expect(terminalClientFrameSchema.safeParse({ type: 'session-control', termId: 'c', action: 'rename', sessionId, name }).success).toBe(false);
 const frame = { type: 'session-result', termId: 'c', lines: [], name: 'api-work' };
 const canonical = terminalServerFrameSchema.parse(frame);
 const browser = parseTerminalServerFrame(frame);
 expect(browser).toEqual({ ok: true, data: canonical });
});

it('[TC-PDUI-237] validates stable tmux targets and ready identities independently of native UUIDs', () => {
 const ready = { type: 'ready', termId: 't', tmuxId: '$12', pid: 42 };
 expect(parseTerminalServerFrame(ready)).toEqual({ ok: true, data: terminalServerFrameSchema.parse(ready) });
 for (const tmuxId of ['name', '-a', '$3;kill-server', '$']) expect(parseTerminalServerFrame({ ...ready, tmuxId }).ok).toBe(false);
});

describe('reboot restore travels as an optional, additive field', () => {
	const sessionId = 'd5ac0000-0000-4000-8000-000000000001';
	const ready = { type: 'ready', termId: 's14', backend: 'native', sessionId, pid: 7, restored: { reason: 'reboot' } };

	it('[TC-PDPROTO-016] a ready frame says a session was reopened, and both parsers agree', () => {
		const canonical = terminalServerFrameSchema.parse(ready);
		expect(canonical).toMatchObject({ restored: { reason: 'reboot' } });
		expect(parseTerminalServerFrame(ready)).toEqual({ ok: true, data: canonical });
		// Agents older than restore never send it; their frame is unchanged.
		const { restored: _restored, ...old } = ready;
		expect(terminalServerFrameSchema.parse(old)).not.toHaveProperty('restored');
		expect(parseTerminalServerFrame(old)).toEqual({ ok: true, data: terminalServerFrameSchema.parse(old) });
	});

	it('[TC-PDPROTO-017] an unknown restore reason is refused by the contract and ignored by the browser', () => {
		const future = { ...ready, restored: { reason: 'crash' } };
		expect(terminalServerFrameSchema.safeParse(future).success).toBe(false);
		// The browser keeps the terminal and only drops the announcement it cannot read.
		const browser = parseTerminalServerFrame(future);
		expect(browser.ok).toBe(true);
		if (browser.ok) expect(browser.data).not.toHaveProperty('restored');
	});

	it('[TC-PDPROTO-018] an open target carries the saved tmux id together with its name', () => {
		const frame = { type: 'open', termId: 's12', target: { kind: 'session', backend: 'tmux', tmuxId: '$0', session: 'claude-1', cols: 80, rows: 24 } };
		expect(terminalClientFrameSchema.parse(frame)).toMatchObject({ target: { tmuxId: '$0', session: 'claude-1' } });
	});
});
