import { describe, expect, it } from 'vitest';
import {
	EPHEMERAL_PORT_MIN,
	discoveredPorts,
	filterPorts,
	foldReason,
	suggestServiceLabel,
	type ListenerInput,
} from '../src/index.js';

const listener = (port: number, process = '', loopbackOnly = true): ListenerInput => ({
	port,
	process,
	loopbackOnly,
});

describe('[TC-PDCORE-091] folding a host that listens on everything', () => {
	it('[TC-PDCORE-091] folds the ports a person did not start, and shows the ones they did', () => {
		// ⚠ EACH FOLDED ROW IS REACHABLE BY EXACTLY ONE RULE. Written the obvious
		// way the rules overlap — `ControlCenter` on 5000 is caught by its port AND
		// its name — and this assertion then passed with a whole rule deleted. So
		// 631 has no process to match, and 60123 is held by a process nobody folds.
		const { shown, folded } = discoveredPorts([
			listener(631, ''), // printing: the port rule alone
			listener(9222, 'Google Chrome'), // every tab and cookie: the name rule alone
			listener(60123, 'node'), // kernel-assigned: the ephemeral rule alone
			listener(5173, 'node'), // vite
			listener(5432, 'postgres'), // the work, on a developer's machine
			listener(6379, 'redis-server'),
			listener(3000, 'docker'),
		]);

		expect(shown.map((row) => row.port)).toEqual([3000, 5173, 5432, 6379]);
		expect(folded.map((row) => row.port)).toEqual([631, 9222, 60123]);
	});

	it('[TC-PDCORE-091] says WHY each port was folded', () => {
		// ⚠ THE REASON IS THE POINT. A fold with no explanation is indistinguishable
		// from a bug to the person whose port is missing, and that person then goes
		// back to ssh — which is the workflow this feature exists to replace.
		expect(foldReason(listener(7000, 'ControlCenter'))).toBe('system-port');
		expect(foldReason(listener(9222, 'Google Chrome'))).toBe('system-process');
		expect(foldReason(listener(60123, 'node'))).toBe('ephemeral');
		expect(foldReason(listener(5173, 'node'))).toBeNull();
	});

	it('[TC-PDCORE-091] a named system process on a high port is named, not blamed on the kernel', () => {
		// Both rules match here. Reporting `ephemeral` would tell somebody the port
		// moves on every restart, when the real reason is what is holding it.
		expect(foldReason(listener(EPHEMERAL_PORT_MIN + 10, 'Google Chrome'))).toBe('system-process');
	});

	it('[TC-PDCORE-091] matches a process name whole, never as a substring', () => {
		// `node` is inside plenty of names a developer owns, and folding by
		// substring would quietly hide the very thing being looked for.
		expect(foldReason(listener(4000, 'my-sshd-helper'))).toBeNull();
		expect(foldReason(listener(4001, 'firefox-devtools-proxy'))).toBeNull();
		// Case and surrounding whitespace are not a difference a person intends.
		expect(foldReason({ port: 4002, process: '  Google Chrome  ' })).toBe('system-process');
	});

	it('[TC-PDCORE-091] leaves a developer database alone', () => {
		// ⚠ THE BAR FOR SYSTEM_PORTS IS "NOBODY STARTS THIS ON PURPOSE". Postgres,
		// Redis and MySQL fail that bar on a developer's machine — there they are
		// the work, and folding them would hide the most-wanted rows in the list.
		for (const port of [5432, 6379, 3306, 27017, 8080, 3000, 5173]) {
			expect(foldReason(listener(port, 'anything'))).toBeNull();
		}
	});
});

describe('[TC-PDCORE-092] what the table is for', () => {
	it('[TC-PDCORE-092] drops ports that are already registered services', () => {
		// They are on the services table directly above, with a probe result and a
		// link — strictly more than this table can say. What remains is the actual
		// question: what is running here that pdmux does not know about.
		const { shown, folded } = discoveredPorts(
			[listener(5173, 'node'), listener(5432, 'postgres'), listener(9222, 'Google Chrome')],
			[5432, 9222],
		);
		expect(shown.map((row) => row.port)).toEqual([5173]);
		expect(folded).toEqual([]);
	});

	it('[TC-PDCORE-092] an absent loopback flag is not a promise of confinement', () => {
		// Whatever later forwards a port turns on this bit. Unknown must read as
		// "reachable", because the opposite error understates exposure.
		const { shown } = discoveredPorts([{ port: 4000 }, { port: 4001, loopbackOnly: true }]);
		expect(shown.map((row) => row.loopbackOnly)).toEqual([false, true]);
	});

	it('[TC-PDCORE-092] survives junk without throwing inside a render', () => {
		const { shown, folded } = discoveredPorts(
			[
				listener(0),
				listener(70000),
				{ port: Number.NaN },
				{ port: 5173, process: null },
				{ port: 5173, process: 'duplicate' },
				null as unknown as ListenerInput,
			],
			null,
		);
		expect(shown).toEqual([{ port: 5173, process: '', loopbackOnly: false, folded: null }]);
		expect(folded).toEqual([]);
		expect(discoveredPorts(null).shown).toEqual([]);
		expect(discoveredPorts(undefined as never, undefined).folded).toEqual([]);
	});

	it('[TC-PDCORE-092] sorts by port so the table does not reshuffle between polls', () => {
		const { shown } = discoveredPorts([listener(9000), listener(3000), listener(5173)]);
		expect(shown.map((row) => row.port)).toEqual([3000, 5173, 9000]);
	});
});

describe('[TC-PDCORE-093] naming a port somebody is about to register', () => {
	it('[TC-PDCORE-093] carries the port, because one host runs four of the same thing', () => {
		expect(suggestServiceLabel(listener(5432, 'postgres'))).toBe('postgres-5432');
		expect(suggestServiceLabel(listener(5173, 'node'))).toBe('node-5173');
	});

	it('[TC-PDCORE-093] names a port whose process could not be attributed', () => {
		expect(suggestServiceLabel({ port: 8080 })).toBe('port-8080');
		expect(suggestServiceLabel({ port: 8080, process: '   ' })).toBe('port-8080');
	});

	it('[TC-PDCORE-093] avoids a label the host already has', () => {
		// Labels are unique per host and the API rejects a duplicate — a suggestion
		// that collides opens a dialog that cannot be submitted, which reads as the
		// button being broken.
		expect(suggestServiceLabel(listener(5432, 'postgres'), ['postgres-5432'])).toBe('postgres-5432-2');
		expect(
			suggestServiceLabel(listener(5432, 'postgres'), ['postgres-5432', 'postgres-5432-2']),
		).toBe('postgres-5432-3');
		// The comparison is case-insensitive: the API's uniqueness check is, and a
		// suggestion that differs only in case would be rejected on submit.
		expect(suggestServiceLabel(listener(5432, 'postgres'), ['POSTGRES-5432'])).toBe('postgres-5432-2');
	});

	it('[TC-PDCORE-093] never exceeds the length the API accepts', () => {
		const long = suggestServiceLabel({ port: 5432, process: 'x'.repeat(200) });
		expect(long.length).toBeLessThanOrEqual(64);
		const collided = suggestServiceLabel({ port: 5432, process: 'x'.repeat(200) }, [long]);
		expect(collided.length).toBeLessThanOrEqual(64);
		expect(collided).not.toBe(long);
	});

	it('[TC-PDCORE-093] reduces a process name to what a label may contain', () => {
		expect(suggestServiceLabel({ port: 5000, process: 'Google Chrome' })).toBe('google-chrome-5000');
		expect(suggestServiceLabel({ port: 5001, process: '__weird__' })).toBe('weird-5001');
	});
});

describe('[TC-PDCORE-094] finding one port among sixty', () => {
	const all = () =>
		discoveredPorts([
			listener(5432, 'postgres'),
			listener(15432, 'com.docker.backend'),
			listener(5173, 'node'),
			listener(9222, 'Google Chrome'), // folded: system process
			listener(60123, 'node'), // folded: kernel-assigned
		]);

	it('[TC-PDCORE-094] matches the digits anywhere in the port, not just the start', () => {
		// ⚠ THE PREFIX VERSION IS THE WRONG ONE, and it looks right until you try
		// it: a machine running four databases answers "543" with 5432 only, while
		// the one being hunted for is 15432.
		const { shown } = all();
		expect(filterPorts(shown, '543').map((row) => row.port)).toEqual([5432, 15432]);
	});

	it('[TC-PDCORE-094] matches a process name case-insensitively', () => {
		const { shown } = all();
		expect(filterPorts(shown, 'DOCKER').map((row) => row.port)).toEqual([15432]);
		expect(filterPorts(shown, 'node').map((row) => row.port)).toEqual([5173]);
	});

	it('[TC-PDCORE-094] searches the folded ports when it is given them', () => {
		// ⚠ THE WHOLE REASON THIS IS A SEPARATE FUNCTION. Folding decides what to
		// show FIRST; it never claims those ports are absent. Searching only the
		// visible half answers "no results" for a port that is sitting right there,
		// which reads as a broken tool — the exact reaction folding exists to
		// avoid. The caller passes shown+folded; here we prove both are reachable.
		const { shown, folded } = all();
		expect(filterPorts(shown, '9222')).toEqual([]);
		expect(filterPorts([...shown, ...folded], '9222').map((row) => row.port)).toEqual([9222]);
		expect(filterPorts([...shown, ...folded], 'chrome').map((row) => row.port)).toEqual([9222]);
	});

	it('[TC-PDCORE-094] an empty query is not a filter', () => {
		const { shown } = all();
		expect(filterPorts(shown, '').map((row) => row.port)).toEqual(shown.map((row) => row.port));
		expect(filterPorts(shown, '   ').map((row) => row.port)).toEqual(shown.map((row) => row.port));
		expect(filterPorts(shown, null).map((row) => row.port)).toEqual(shown.map((row) => row.port));
	});

	it('[TC-PDCORE-094] survives junk without throwing inside a render', () => {
		expect(filterPorts(null, 'x')).toEqual([]);
		expect(filterPorts(undefined, undefined)).toEqual([]);
		expect(filterPorts(all().shown, 'zzzz')).toEqual([]);
	});
});
