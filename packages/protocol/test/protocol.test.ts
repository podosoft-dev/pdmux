/**
 * The contract's own tests. Two things are being protected here:
 *
 *  1. **Nothing crosses a boundary unvalidated.** Every frame arrives from another
 *     machine, so a malformed one must be rejected as data — never crash a
 *     connection or a collector pass.
 *  2. **Additive-only evolution.** An agent installed on a host you cannot upgrade
 *     today keeps talking the version it shipped with. If a rename or a removal
 *     ever lands, the frozen key list below fails and the change has to be made
 *     as an addition instead.
 */
import { describe, expect, it } from 'vitest';
import {
	AGENT_KEY_HEADER,
	AGENT_WS_PATH,
	DIFF_CAPS,
	PROTOCOL_VERSION,
	TERMINAL_WS_PATH,
	agentConfigSchema,
	agentDownstreamSchema,
	agentHelloSchema,
	agentUpstreamSchema,
	agentUpdateSchema,
	agentExecSchema,
	commitDetailSchema,
	execResultSchema,
	EXEC_OUTPUT_MAX,
	gitRefSchema,
	gitUncommittedSchema,
	heartbeatSchema,
	repoSnapshotSchema,
	safeParse,
	terminalClientFrameSchema,
	terminalServerFrameSchema,
	terminalTargetSchema,
	usageWindowSchema,
} from '../src/index.js';

describe('[TC-PDPROTO-001] heartbeat frames are validated, defaulted and range-checked', () => {
	it('[TC-PDPROTO-001] fills every optional field so a consumer never guards for undefined', () => {
		const parsed = heartbeatSchema.parse({ ts: 1_784_000_000 });
		expect(parsed.resource.cpuPct).toBeNull();
		expect(parsed.sessions).toEqual([]);
		expect(parsed.usage).toEqual([]);
		expect(parsed.services).toEqual([]);
	});

	it('[TC-PDPROTO-001] rejects out-of-range percentages instead of storing nonsense', () => {
		const bad = heartbeatSchema.safeParse({ ts: 1, resource: { cpuPct: 140 } });
		expect(bad.success).toBe(false);
		const negative = heartbeatSchema.safeParse({ ts: -1 });
		expect(negative.success).toBe(false);
	});

	it('[TC-PDPROTO-001] keeps absolute bytes alongside the percentages', () => {
		// A tooltip needs "12Gi/30Gi"; a percentage alone cannot produce it, which is
		// why both travel together.
		const parsed = heartbeatSchema.parse({
			ts: 2,
			resource: { memPct: 41, memUsedBytes: 3_300_000_000, memTotalBytes: 8_200_000_000 },
		});
		expect(parsed.resource.memUsedBytes).toBe(3_300_000_000);
		expect(parsed.resource.memTotalBytes).toBe(8_200_000_000);
	});
});

describe('[TC-PDPROTO-002] usage windows carry both polarities and a reset time', () => {
	it('[TC-PDPROTO-002] accepts a used-only report and a remaining-only report', () => {
		// Providers disagree: one reports what is spent, the other what is left. The
		// contract stores whichever arrived rather than forcing a conversion here.
		const used = usageWindowSchema.parse({ key: 'session', usedPct: 3 });
		expect(used.usedPct).toBe(3);
		expect(used.remainingPct).toBeNull();
		const remaining = usageWindowSchema.parse({ key: 'weekly', remainingPct: 70 });
		expect(remaining.remainingPct).toBe(70);
		expect(remaining.usedPct).toBeNull();
	});

	it('[TC-PDPROTO-002] keeps resetsAt nullable so an unsupported window is expressible', () => {
		expect(usageWindowSchema.parse({ key: 'session' }).resetsAt).toBeNull();
	});
});

describe('[TC-PDPROTO-003] repo snapshots separate graph rows from click-time detail', () => {
	it('[TC-PDPROTO-003] a commit row carries no body and no patch', () => {
		const snapshot = repoSnapshotSchema.parse({
			path: '/srv/app', name: 'app', ts: 10,
			commits: [{ sha: 'abcdef1234567', subject: 'fix: thing' }],
		});
		const row = snapshot.commits[0];
		expect(Object.keys(row ?? {}).sort()).toEqual(['author', 'date', 'parents', 'refs', 'sha', 'subject']);
		// The message body and the patch were 58% of the old feed and are never
		// rendered before a click, so they live in `details`, fetched on demand.
		expect(snapshot.details).toEqual([]);
		expect(snapshot.pending).toBe(0);
	});

	it('[TC-PDPROTO-003] an empty patch is expressible, so a merge is not recomputed forever', () => {
		const detail = commitDetailSchema.parse({ sha: 'abcdef1234567', empty: true });
		expect(detail.empty).toBe(true);
		expect(detail.files).toEqual([]);
	});

	it('[TC-PDPROTO-003] a per-repo error replaces the data instead of failing the pass', () => {
		const snapshot = repoSnapshotSchema.parse({
			path: '/srv/broken', name: 'broken', ts: 3, error: 'not a git checkout',
		});
		expect(snapshot.error).toBe('not a git checkout');
		expect(snapshot.commits).toEqual([]);
	});

	it('[TC-PDPROTO-003] publishes the caps a producer must apply before the wire', () => {
		// A line cap alone let a single 50,000-character lock-file line through and
		// produced a multi-megabyte payload, so bytes and line length are capped too.
		expect(DIFF_CAPS.maxBytes).toBe(200_000);
		expect(DIFF_CAPS.maxFileLines).toBe(800);
		expect(DIFF_CAPS.maxLineChars).toBe(500);
	});
});

describe('[TC-PDPROTO-004] terminal frames are a closed set with safe defaults', () => {
	it('[TC-PDPROTO-004] defaults a target to a persistent session at 80x24', () => {
		const target = terminalTargetSchema.parse({});
		expect(target.kind).toBe('session');
		expect([target.cols, target.rows]).toEqual([80, 24]);
	});

	it('[TC-PDPROTO-004] refuses a session name that could escape a shell argument', () => {
		for (const session of ['a b', 'a;rm -rf /', '$(id)', '../etc', 'x'.repeat(33)]) {
			expect(terminalTargetSchema.safeParse({ session }).success).toBe(false);
		}
		expect(terminalTargetSchema.safeParse({ session: 'main-1_x' }).success).toBe(true);
	});

	it('[TC-PDPROTO-004] rejects an unknown frame type', () => {
		expect(terminalClientFrameSchema.safeParse({ type: 'exec', termId: 't1' }).success).toBe(false);
		expect(terminalClientFrameSchema.safeParse({ type: 'input', termId: 't1', data: 'ls\r' }).success).toBe(true);
	});
});

describe('[TC-PDPROTO-005] the envelope and the server-sent config', () => {
	it('[TC-PDPROTO-005] discriminates upstream and downstream frames by type', () => {
		expect(agentUpstreamSchema.safeParse({ type: 'pong', ts: 5 }).success).toBe(true);
		expect(agentUpstreamSchema.safeParse({ type: 'welcome' }).success).toBe(false);
		expect(agentDownstreamSchema.safeParse({ type: 'ping', ts: 5 }).success).toBe(true);
		expect(agentDownstreamSchema.safeParse({ type: 'heartbeat' }).success).toBe(false);
	});

	it('[TC-PDPROTO-005] gives an unconfigured agent working defaults', () => {
		// A host must be useful the moment it connects, before anyone opens settings.
		const config = agentConfigSchema.parse({});
		expect(config.heartbeatSec).toBe(5);
		expect(config.gitIntervalSec).toBe(120);
		expect(config.gitLimit).toBe(300);
		expect(config.gitDetailBudget).toBe(120);
		expect(config.gitRoots).toEqual([]);
		expect(config.services).toEqual([]);
	});

	it('[TC-PDPROTO-005] bounds the intervals a compromised server could push', () => {
		expect(agentConfigSchema.safeParse({ heartbeatSec: 0 }).success).toBe(false);
		expect(agentConfigSchema.safeParse({ gitIntervalSec: 1 }).success).toBe(false);
		expect(agentConfigSchema.safeParse({ gitLimit: 99_999 }).success).toBe(false);
	});
});

describe('[TC-PDPROTO-006] safeParse never throws and names the offending field', () => {
	it('[TC-PDPROTO-006] returns ok:false with a path for malformed input', () => {
		const result = safeParse(heartbeatSchema, { ts: 'now' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('ts');
	});

	it('[TC-PDPROTO-006] survives values that are not objects at all', () => {
		for (const value of [null, undefined, 42, 'x', [], () => undefined]) {
			expect(() => safeParse(agentUpstreamSchema, value)).not.toThrow();
			expect(safeParse(agentUpstreamSchema, value).ok).toBe(false);
		}
	});
});

describe('[TC-PDPROTO-007] the contract evolves additively', () => {
	it('[TC-PDPROTO-007] freezes the top-level key sets of the wire types', () => {
		// Renaming or removing a key breaks every already-installed agent. If this
		// list has to change, the change must be an ADDITION (and a version bump if
		// a reader really cannot cope).
		expect(Object.keys(heartbeatSchema.shape).sort()).toEqual([
			'diagnostics',
			'listeners',
			'resource',
			'services',
			'sessions',
			'ts',
			'usage',
		]);
		// `remote`, then `tree` and `blob`, were added for the on-demand checks: all
		// three are ADDITIONS, so an agent that has never heard of them still produces
		// a valid snapshot — which is the property this list exists to keep.
		expect(Object.keys(repoSnapshotSchema.shape).sort()).toEqual([
			'blob', 'commits', 'details', 'error', 'head', 'limit', 'name', 'partial', 'path', 'pending',
			'refs', 'remote', 'tree', 'truncated', 'ts', 'uncommitted', 'workingDiff',
		]);
		expect(Object.keys(agentConfigSchema.shape).sort()).toEqual([
			'bodyMaxChars', 'gitDetailBudget', 'gitIntervalSec', 'gitLimit', 'gitRoots', 'heartbeatSec',
			'probeTimeoutMs', 'services', 'statusFileCap', 'terminalBufferBytes', 'usageIntervalSec',
			'usageProviders',
		]);
	});

	it('[TC-PDPROTO-007] pins the version and the paths both sides dial', () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(AGENT_WS_PATH).toBe('/agent/ws');
		expect(TERMINAL_WS_PATH).toBe('/terminal/ws');
		expect(AGENT_KEY_HEADER).toBe('x-api-key');
	});

	it('[TC-PDPROTO-007] ignores unknown fields so a newer agent still talks to an older server', () => {
		const parsed = heartbeatSchema.parse({ ts: 1, somethingAddedLater: true });
		expect('somethingAddedLater' in parsed).toBe(false);
		expect(parsed.ts).toBe(1);
	});
});

describe('[TC-PDPROTO-008] the additions that came out of building the agent', () => {
	it('[TC-PDPROTO-008] a snapshot can answer one click without rebuilding the graph', () => {
		// Replying to a commitDetail request used to force a full snapshot (refs +
		// every row) just to carry a patch the server asked for.
		const partial = repoSnapshotSchema.parse({ path: '/p', name: 'p', ts: 1, partial: true });
		expect(partial.partial).toBe(true);
		expect(repoSnapshotSchema.parse({ path: '/p', name: 'p', ts: 1 }).partial).toBe(false);
	});

	it('[TC-PDPROTO-008] the server can tell an agent which details it already stored', () => {
		// Details are immutable per sha, so a restarted agent must not spend its whole
		// budget rebuilding patches the server has.
		const ack = agentDownstreamSchema.safeParse({
			type: 'detailAck', repoPath: '/p', shas: ['abcdef1234567'],
		});
		expect(ack.success).toBe(true);
	});

	it('[TC-PDPROTO-008] a branch whose upstream is gone, and a dirty submodule, are expressible', () => {
		// Both existed in the tool this generalises: a "clean" checkout with a moved
		// submodule pointer commits something the author did not expect.
		expect(gitRefSchema.parse({ name: 'feat/x', kind: 'local', sha: 'abcdef1', gone: true }).gone).toBe(true);
		expect(gitUncommittedSchema.parse({ submodules: 2 }).submodules).toBe(2);
	});

	it('[TC-PDPROTO-008] dropped terminal bytes are announced rather than hidden', () => {
		// A runaway command outruns any consumer; dropping is the only option left, so
		// the pane says how much instead of silently corrupting the stream.
		const frame = terminalServerFrameSchema.parse({ type: 'output', termId: 't', data: 'x', dropped: 4096 });
		expect(frame.type === 'output' && frame.dropped).toBe(4096);
	});

	it('[TC-PDPROTO-008] the intervals the agent used to hardcode are server-controlled and bounded', () => {
		const config = agentConfigSchema.parse({});
		expect(config.usageIntervalSec).toBe(60);
		expect(config.probeTimeoutMs).toBe(2000);
		expect(config.statusFileCap).toBe(300);
		expect(config.bodyMaxChars).toBe(1200);
		expect(config.terminalBufferBytes).toBe(262_144);
		expect(agentConfigSchema.safeParse({ probeTimeoutMs: 60_000 }).success).toBe(false);
		expect(agentConfigSchema.safeParse({ usageIntervalSec: 1 }).success).toBe(false);
	});
});

describe('[TC-PDPROTO-009] a degraded host says so in-band', () => {
	it('[TC-PDPROTO-009] carries diagnostics with a translatable code and a fallback message', () => {
		// Building the agent showed the gap: "git is missing" or "the PTY fell back to
		// a limited mode" only appeared in `doctor` output on the host, which nobody
		// runs before they already suspect something.
		const beat = heartbeatSchema.parse({
			ts: 1,
			diagnostics: [{ level: 'warn', code: 'pty.fallback', message: 'node-pty unavailable' }],
		});
		expect(beat.diagnostics[0]?.code).toBe('pty.fallback');
		expect(heartbeatSchema.parse({ ts: 1 }).diagnostics).toEqual([]);
	});
});

describe('[TC-PDPROTO-012] remote update is bounded by the contract, not by the agent alone', () => {
	const validUpdate = {
		commandId: '0f1b8b3e-6a5e-4f0a-9a1a-2c3d4e5f6a7b',
		version: '0.2.0',
		artifactPath: '/agent/0.2.0/pdmux-agent-linux-amd64',
		sha256: 'a'.repeat(64),
		bytes: 12_345_678,
		os: 'linux',
		arch: 'amd64',
	};

	it('[TC-PDPROTO-012] refuses anything that could send the fleet to another host', () => {
		// This is the property that keeps remote update a CONVENIENCE over a power the
		// server already has (it can open a PTY) rather than a NEW one. An absolute URL
		// would make every host fetch arbitrary bytes from an arbitrary origin, using
		// the fleet's egress identity. Rejected as data, before any download.
		for (const artifactPath of [
			'https://evil.example/agent',
			'//evil.example/agent', // protocol-relative — resolves against another host
			'agent/0.2.0/bin', // relative — would resolve against the current path
			'/agent/bin?x=1',
			'/agent/bin#f',
			'/agent/bin\nX',
			'/agent/ bin',
			'',
		]) {
			expect(agentUpdateSchema.safeParse({ ...validUpdate, artifactPath }).success).toBe(false);
		}
		expect(agentUpdateSchema.safeParse(validUpdate).success).toBe(true);
		// A version directory has dots in it; the class must not have broken that.
		expect(agentUpdateSchema.safeParse({ ...validUpdate, artifactPath: '/agent/1.2.3-rc.1/a_b-c' }).success).toBe(true);
	});

	it('[TC-PDPROTO-012] pins the bytes, and says so in a shape a generator cannot soften', () => {
		// A malformed hash is never a compatibility question, always a bug — so unlike
		// `agentVersion` this field IS pattern-checked. Upper case is rejected too, so
		// two sides never disagree about how to compare it.
		expect(agentUpdateSchema.safeParse({ ...validUpdate, sha256: 'A'.repeat(64) }).success).toBe(false);
		expect(agentUpdateSchema.safeParse({ ...validUpdate, sha256: 'a'.repeat(63) }).success).toBe(false);
		expect(agentUpdateSchema.safeParse({ ...validUpdate, bytes: 0 }).success).toBe(false);
	});

	it('[TC-PDPROTO-012] defaults the two fields an operator should not have to think about', () => {
		const parsed = agentUpdateSchema.parse(validUpdate);
		expect(parsed.force).toBe(false);
		expect(parsed.probationSec).toBe(300);
		// The probation window is bounded on both sides: too short and a slow host rolls
		// itself back for being slow; too long and a broken one sits there unnoticed.
		expect(agentUpdateSchema.safeParse({ ...validUpdate, probationSec: 5 }).success).toBe(false);
		expect(agentUpdateSchema.safeParse({ ...validUpdate, probationSec: 86_400 }).success).toBe(false);
	});

	it('[TC-PDPROTO-012] an agent that predates update says so by omission', () => {
		// Every agent built before this feature sends no `update` object at all, and the
		// default has to read as "do NOT offer the button" — an update that ends in
		// `exit` on a host with nothing to restart it is a hole the agent never leaves.
		const hello = agentHelloSchema.parse({
			protocolVersion: PROTOCOL_VERSION,
			agentVersion: '0.1.0',
			hostname: 'h',
			os: 'linux',
			arch: 'amd64',
		});
		expect(hello.update).toEqual({ canRestart: false, restartMode: 'none' });
	});

	it('[TC-PDPROTO-012] every outcome is reported by a connected agent, with a groupable code', () => {
		const accepted = agentUpstreamSchema.safeParse({
			type: 'updateStatus',
			update: { commandId: validUpdate.commandId, phase: 'accepted', currentVersion: '0.1.0', shellPanes: 2, sessionPanes: 3 },
		});
		expect(accepted.success).toBe(true);
		// `done` comes from the NEW binary and `rolledBack` from the OLD one, so the
		// server never has to read a silence as a failure.
		for (const phase of ['done', 'rolledBack', 'failed'] as const) {
			expect(
				agentUpstreamSchema.safeParse({
					type: 'updateStatus',
					update: { commandId: validUpdate.commandId, phase, currentVersion: '0.1.0', code: 'SHA_MISMATCH' },
				}).success,
			).toBe(true);
		}
		expect(
			agentUpstreamSchema.safeParse({
				type: 'updateStatus',
				update: { commandId: validUpdate.commandId, phase: 'invented', currentVersion: '0.1.0' },
			}).success,
		).toBe(false);
	});

	it('[TC-PDPROTO-012] an agent built before this release drops the frame instead of dying', () => {
		// The reader's contract: an unknown `type` fails safeParse, is logged and
		// dropped, and the connection survives. That is what makes these three frames
		// safe to ship to a fleet that cannot all be upgraded at once.
		const unknown = safeParse(agentDownstreamSchema, { type: 'somethingFromTheFuture', payload: 1 });
		expect(unknown.ok).toBe(false);
		expect(agentDownstreamSchema.safeParse({ type: 'update', update: validUpdate }).success).toBe(true);
		// `welcome` gained a field; an older server that omits it still parses.
		const welcome = agentDownstreamSchema.parse({
			type: 'welcome',
			hostId: '0f1b8b3e-6a5e-4f0a-9a1a-2c3d4e5f6a7b',
			config: {},
		});
		expect(welcome.type === 'welcome' && welcome.serverVersion).toBe('');
	});
});

/**
 * Running a command on a host is the one thing in this contract that is not a
 * measurement — it changes the machine. So the shape is where the limits live,
 * before any agent has a chance to be careless with them.
 */
describe('[TC-PDMCP-001] a command is bounded by the contract, not by the agent alone', () => {
	const validExec = {
		commandId: '00000000-0000-4000-8000-000000000001',
		command: 'git',
		args: ['status', '--porcelain'],
	};

	it('[TC-PDMCP-001] keeps the binary and its arguments apart, so there is nothing to inject into', () => {
		// THE POINT OF THE SPLIT: one string would have to reach a shell, and then a
		// filename with a semicolon in it runs a second command. Here metacharacters
		// are just characters — they arrive as one argument and stay one argument.
		const parsed = agentExecSchema.parse({
			...validExec,
			command: 'rm',
			args: ['a; rm -rf /', '$(whoami)', '`id`', '&& shutdown'],
		});
		expect(parsed.args).toEqual(['a; rm -rf /', '$(whoami)', '`id`', '&& shutdown']);
		// And there is no field a caller could smuggle a shell line through.
		expect(Object.keys(parsed).sort()).toEqual(['args', 'command', 'commandId', 'cwd', 'timeoutMs']);
	});

	it('[TC-PDMCP-001] refuses an unbounded or absent command', () => {
		for (const patch of [
			{ command: '' },
			{ command: 'x'.repeat(257) },
			{ args: Array.from({ length: 65 }, () => 'a') },
			{ timeoutMs: 999 }, // below the floor
			{ timeoutMs: 600_001 }, // above the ceiling
			{ commandId: 'not-a-uuid' },
		]) {
			expect(agentExecSchema.safeParse({ ...validExec, ...patch }).success).toBe(false);
		}
		expect(agentExecSchema.safeParse(validExec).success).toBe(true);
	});

	it('[TC-PDMCP-001] defaults the parts a caller should not have to think about', () => {
		const parsed = agentExecSchema.parse({ commandId: validExec.commandId, command: 'uptime' });
		expect(parsed.args).toEqual([]);
		expect(parsed.cwd).toBeNull();
		// A timeout of "none" is how one call holds a slot forever; there is no such value.
		expect(parsed.timeoutMs).toBe(30_000);
	});
});

describe('[TC-PDMCP-002] the answer says what happened, not just what was printed', () => {
	const validResult = { commandId: '00000000-0000-4000-8000-000000000001', exitCode: 0 };
	const validExecFrame = { commandId: validResult.commandId, command: 'uptime' };
	const helloBase = {
		protocolVersion: PROTOCOL_VERSION,
		agentVersion: '0.1.0',
		hostname: 'h',
		os: 'linux',
		arch: 'amd64',
	};

	it('[TC-PDMCP-002] carries an exit code, which is the whole reason this is not a terminal', () => {
		expect(execResultSchema.parse(validResult).exitCode).toBe(0);
		// -1 is `sys.Run`'s own convention for killed-or-never-started, carried through
		// rather than translated so the two sides cannot drift.
		expect(execResultSchema.parse({ ...validResult, exitCode: -1 }).exitCode).toBe(-1);
		expect(execResultSchema.safeParse({ commandId: validResult.commandId }).success).toBe(false);
	});

	it('[TC-PDMCP-002] separates "we stopped it" from "it failed", and says when output was cut', () => {
		const timedOut = execResultSchema.parse({ ...validResult, exitCode: -1, timedOut: true });
		expect(timedOut.timedOut).toBe(true);
		const clean = execResultSchema.parse({ ...validResult, exitCode: 1 });
		expect(clean.timedOut).toBe(false);
		expect(clean.truncated).toBe(false);
		expect(clean.code).toBeNull();
	});

	it('[TC-PDMCP-002] refuses output past the cap rather than letting a frame grow without limit', () => {
		// The agent truncates to this and sets `truncated`; a frame that ignored the cap
		// would be rejected here instead of quietly becoming a very large message.
		expect(execResultSchema.safeParse({ ...validResult, stdout: 'a'.repeat(EXEC_OUTPUT_MAX) }).success).toBe(true);
		expect(execResultSchema.safeParse({ ...validResult, stdout: 'a'.repeat(EXEC_OUTPUT_MAX + 1) }).success).toBe(
			false,
		);
	});

	it('[TC-PDMCP-002] rides both envelopes, and the capability announces it', () => {
		expect(agentDownstreamSchema.safeParse({ type: 'exec', exec: validExecFrame }).success).toBe(true);
		expect(agentUpstreamSchema.safeParse({ type: 'execResult', result: validResult }).success).toBe(true);
		// An agent too old to run commands simply does not list it, which is what the
		// server reads before sending anything.
		expect(agentHelloSchema.parse({ ...helloBase, capabilities: ['exec'] }).capabilities).toEqual(['exec']);
		expect(agentHelloSchema.safeParse({ ...helloBase, capabilities: ['nope'] }).success).toBe(false);
	});
});
