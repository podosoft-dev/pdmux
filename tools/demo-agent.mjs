#!/usr/bin/env node
/**
 * demo-agent — a fleet that does not exist, so the dashboard can be seen without one.
 *
 * WHY THIS EXISTS: every screen in this product is a picture of somebody's machines.
 * To look at it — for a screenshot, a design change, a first run after `npm run dev` —
 * you otherwise need real hosts, with real load, real multiplexer sessions and real
 * repositories. That is a lot of setup to look at a layout, and on a laptop the answer
 * is usually one host reporting 4% CPU and nothing else.
 *
 * So this speaks the agent side of the protocol directly: it connects to `/agent/ws`
 * with a host token exactly as the real agent does, then sends `hello`, `heartbeat`
 * and `repos` frames built from a small synthetic profile. The server cannot tell the
 * difference, because there is none that matters — the frames are the contract.
 *
 * ⚠ EVERYTHING IT SENDS IS INVENTED, AND THAT IS A FEATURE. A screenshot taken against
 * real agents carries whatever was on those machines: absolute paths with somebody's
 * username in them, branch names from private work, a service URL on an internal
 * network. The generalisation audit cannot see any of that, because it does not read
 * images. A fleet that never existed cannot leak anything.
 *
 * ⚠ IT IS NOT A TEST DOUBLE. Nothing asserts against it; the conformance corpus is
 * where the two implementations are held to the same contract. This is a way to look
 * at the product.
 *
 * Usage:
 *   node tools/demo-agent.mjs --server http://pdmux.localhost --token pdmux_… --profile build
 *   node tools/demo-agent.mjs --list-profiles
 */
import { WebSocket } from 'ws';

const PROFILES = {
	/** A busy build machine: high load, several sessions, two repositories. */
	build: {
		hostname: 'build-01',
		os: 'linux',
		arch: 'amd64',
		cpu: [58, 96],
		mem: [61, 74],
		disk: 47,
		memTotal: 32 * 1024 ** 3,
		diskTotal: 512 * 1024 ** 3,
		sessions: [
			{ name: 'main', attached: 1, windows: 3 },
			{ name: 'ci', attached: 0, windows: 2 },
			{ name: 'logs', attached: 0, windows: 1 },
		],
		usage: [{ provider: 'claude', processes: 2, windows: [
			{ key: 'session', label: '5h', remainingPct: 82 },
			{ key: 'weekly', label: '7d', remainingPct: 41 },
		] }],
		repos: ['checkout-service', 'billing-api'],
		transcript: [
			'npm test -w @billing/api',
			'\r\n  \u2713 refuses a charge with no idempotency key (4 ms)',
			'\r\n  \u2713 the retry reuses the key rather than minting one (2 ms)',
			'\r\n  \u2713 a duplicate settles to the same charge id (6 ms)',
			'\r\n\r\n\x1b[32m  3 passed\x1b[0m (0.4 s)\r\n',
		],
	},
	/** A quiet database host: no coding agent, one repository, low load. */
	db: {
		hostname: 'db-02',
		os: 'linux',
		arch: 'arm64',
		cpu: [3, 11],
		mem: [38, 44],
		disk: 71,
		memTotal: 16 * 1024 ** 3,
		diskTotal: 1024 * 1024 ** 3,
		sessions: [{ name: 'main', attached: 0, windows: 1 }],
		usage: [],
		repos: ['schema'],
		transcript: [
			'psql -c "select now(), count(*) from orders"',
			'\r\n              now              | count ',
			'\r\n -------------------------------+-------',
			'\r\n  2026-08-03 09:12:04.118+00    | 41208',
			'\r\n (1 row)\r\n',
		],
	},
	/** A laptop: moderate load, a coding agent nearly out of budget. */
	laptop: {
		hostname: 'workstation',
		os: 'darwin',
		arch: 'arm64',
		cpu: [12, 38],
		mem: [55, 68],
		disk: 63,
		memTotal: 24 * 1024 ** 3,
		diskTotal: 994 * 1024 ** 3,
		sessions: [
			{ name: 'main', attached: 1, windows: 4 },
			{ name: 'notes', attached: 0, windows: 1 },
		],
		usage: [{ provider: 'claude', processes: 1, windows: [
			{ key: 'session', label: '5h', remainingPct: 17 },
			{ key: 'weekly', label: '7d', remainingPct: 63 },
		] }],
		repos: ['dashboard'],
		transcript: [
			'git status --short',
			'\r\n \x1b[32mM\x1b[0m  src/routes/+page.svelte',
			'\r\n \x1b[31m M\x1b[0m src/lib/chart.ts',
			'\r\n \x1b[31m??\x1b[0m src/lib/chart.test.ts\r\n',
		],
	},
};

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

if (args.includes('--list-profiles')) {
	for (const [id, p] of Object.entries(PROFILES)) console.log(`${id.padEnd(8)} ${p.hostname} (${p.os}/${p.arch})`);
	process.exit(0);
}

const server = flag('server', 'http://pdmux.localhost');
const token = flag('token') ?? process.env.PDMUX_TOKEN;
const profileId = flag('profile', 'build');
const profile = PROFILES[profileId];

if (!token) {
	console.error('need --token pdmux_… (or PDMUX_TOKEN). Mint one on the host detail page.');
	process.exit(2);
}
if (!profile) {
	console.error(`unknown profile ${profileId}. Try --list-profiles.`);
	process.exit(2);
}

const now = () => Math.floor(Date.now() / 1000);
const between = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo + 1));
/** A short hex string that looks like a sha and is stable for a given seed. */
const sha = (seed) => {
	let h = 2166136261;
	for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	return (h >>> 0).toString(16).padStart(8, '0').repeat(5).slice(0, 40);
};

const SUBJECTS = [
	'fix: stop the retry loop from doubling its own backoff',
	'feat: carry the request id through the worker',
	'refactor: move the rate limit next to what it protects',
	'test: pin the boundary that broke in production',
	'fix: read the config before the first connection',
	'docs: record why the cache is per process',
	'perf: read the tail instead of the whole file',
	'fix: treat a missing measurement as unknown, not zero',
];
const AUTHORS = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'];

/** A believable graph: a main line with one branch merged back into it. */
function buildRepo(name, index) {
	const base = now() - 86_400 * 9;
	const commits = [];
	for (let i = 0; i < 24; i += 1) {
		const id = `${name}-${i}`;
		commits.push({
			sha: sha(id),
			parents: i === 0 ? [] : i === 6 ? [sha(`${name}-5`), sha(`${name}-b2`)] : [sha(`${name}-${i - 1}`)],
			refs: i === 23 ? ['HEAD -> main', 'origin/main'] : i === 12 ? ['v1.4.0'] : [],
			author: AUTHORS[i % AUTHORS.length],
			date: base + i * 7_400 + index * 900,
			subject: SUBJECTS[(i + index) % SUBJECTS.length],
		});
	}
	commits.reverse();
	const head = commits[0];
	return {
		path: `/srv/${name}`,
		name,
		ts: now(),
		head: { branch: 'main', sha: head.sha, detached: false, upstream: 'origin/main', ahead: index === 0 ? 2 : 0, behind: 0 },
		refs: [
			{ name: 'main', kind: 'local', sha: head.sha, upstream: 'origin/main', ahead: index === 0 ? 2 : 0, behind: 0 },
			{ name: 'feat/idempotent-retry', kind: 'local', sha: sha(`${name}-b2`), upstream: null, ahead: 4, behind: 1 },
			{ name: 'origin/main', kind: 'remote', sha: sha(`${name}-22`) },
			{ name: 'v1.4.0', kind: 'tag', sha: sha(`${name}-12`) },
		],
		commits,
		uncommitted: index === 0 ? { staged: 1, unstaged: 2, untracked: 1, conflicts: 0, total: 4, files: [], dropped: 0, submodules: 0 } : null,
		limit: 300,
		details: [],
		pending: 0,
	};
}

const url = new URL('/agent/ws', server);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

const ws = new WebSocket(url, { headers: { 'x-api-key': token } });
const send = (frame) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));

const heartbeat = () => ({
	type: 'heartbeat',
	heartbeat: {
		ts: now(),
		resource: {
			cpuPct: between(profile.cpu),
			memPct: between(profile.mem),
			diskPct: profile.disk,
			memTotalBytes: profile.memTotal,
			memUsedBytes: Math.round((profile.memTotal * between(profile.mem)) / 100),
			diskTotalBytes: profile.diskTotal,
			diskUsedBytes: Math.round((profile.diskTotal * profile.disk) / 100),
			load1: Number((between(profile.cpu) / 25).toFixed(2)),
			uptimeSec: 86_400 * 12 + 3_600,
		},
		sessions: profile.sessions,
		usage: profile.usage.map((u) => ({ ...u, ts: now() })),
		// Empty rather than absent: this agent DID look, and found nothing to report.
		// Absent would mean "too old to know about ports", which is a different claim.
		listeners: [],
		diagnostics: [],
	},
});

let timers = [];
ws.on('open', () => {
	send({
		type: 'hello',
		hello: {
			protocolVersion: 1,
			agentVersion: '0.1.7',
			hostname: profile.hostname,
			address: '',
			os: profile.os,
			arch: profile.arch,
			capabilities: ['metrics', 'sessions', 'terminal', 'git', 'usage', 'services'],
			// No supervisor, so the dashboard correctly declines to offer an update —
			// claiming otherwise would put a button here that could only ever fail.
			update: { canRestart: false, restartMode: 'none' },
		},
	});
	console.log(`${profile.hostname}: connected`);
});

ws.on('message', (raw) => {
	let frame;
	try {
		frame = JSON.parse(raw.toString());
	} catch {
		return;
	}
	if (frame.type === 'welcome') {
		const config = frame.config ?? {};
		send(heartbeat());
		send({ type: 'repos', ts: now(), repos: profile.repos.map(buildRepo) });
		timers.push(setInterval(() => send(heartbeat()), (config.heartbeatSec ?? 5) * 1000));
		timers.push(setInterval(() => send({ type: 'repos', ts: now(), repos: profile.repos.map(buildRepo) }), 120_000));
		console.log(`${profile.hostname}: reporting (${profile.repos.length} repo(s), ${profile.sessions.length} session(s))`);
	} else if (frame.type === 'ping') {
		send({ type: 'pong', ts: now() });
	} else if (frame.type === 'collect') {
		send(heartbeat());
	} else if (frame.type === 'terminal' && frame.frame?.type === 'open') {
		// A terminal that prints a fixed transcript. It is not a shell and does not
		// pretend to be one — `input` is ignored, because a demo that echoes typed
		// commands invites somebody to try a real one and be confused when nothing runs.
		const termId = frame.frame.termId;
		send({ type: 'terminal', frame: { type: 'ready', termId, pid: 4242 } });
		const prompt = `\r\n\x1b[1;32m${profile.hostname}\x1b[0m:~$ `;
		const [command, ...rest] = profile.transcript;
		const lines = [`${prompt}${command}\r\n`, ...rest, prompt];
		lines.forEach((data, i) =>
			timers.push(setTimeout(() => send({ type: 'terminal', frame: { type: 'output', termId, data, dropped: 0 } }), 250 + i * 320)),
		);
	}
});

ws.on('close', (code) => {
	timers.forEach(clearInterval);
	timers.forEach(clearTimeout);
	console.log(`${profile.hostname}: closed (${code})`);
	process.exit(code === 1000 ? 0 : 1);
});
ws.on('error', (err) => {
	console.error(`${profile.hostname}: ${err.message}`);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => ws.close(1000));
