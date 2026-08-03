/**
 * Discovered ports: what the host is listening on that nobody has registered.
 *
 * WHY THIS IS A JUDGEMENT AND NOT A FILTER. A developer's machine listens on far
 * more ports than it runs services — measured on one Mac: fifty-nine, of which
 * maybe a dozen were anything a person had started on purpose. Printing all
 * fifty-nine is the same as printing none.
 *
 * ⚠ BUT NOTHING IS DELETED, ONLY FOLDED, and every fold carries the reason it was
 * folded. A list that silently drops the port somebody is looking for does not
 * read as "we filtered that"; it reads as "this tool is broken", and the person
 * goes back to ssh and lsof — which is the thing this feature exists to replace.
 * Guessing wrong is acceptable. Guessing invisibly is not.
 */

export interface ListenerInput {
	port: number;
	process?: string | null;
	loopbackOnly?: boolean | null;
}

/** Why a port was folded away from the default view. `null` means it is shown. */
export type FoldReason = 'ephemeral' | 'system-port' | 'system-process';

export interface DiscoveredPort {
	port: number;
	/** Executable name, or '' when the host could not attribute the socket. */
	process: string;
	loopbackOnly: boolean;
	folded: FoldReason | null;
}

export interface DiscoveredPorts {
	shown: DiscoveredPort[];
	folded: DiscoveredPort[];
}

/**
 * Start of the ephemeral range (IANA, and the default on macOS).
 *
 * ⚠ THIS IS THE MOST USEFUL RULE HERE, and it is not about what the port is — it
 * is about whether it will still be that port tomorrow. A listener the kernel
 * handed out is different after every restart, so registering it as a service
 * produces a row that is wrong by the next reboot. Twenty of the fifty-nine ports
 * measured were this.
 */
export const EPHEMERAL_PORT_MIN = 49152;

/**
 * Ports that belong to the operating system or to the machine's own services.
 *
 * Deliberately short. Every entry folds a port for EVERY host, so a wrong guess
 * here is wrong everywhere — the bar is "no developer ever starts this on
 * purpose", not "this is usually infrastructure". Postgres and Redis are not
 * here for exactly that reason: on a developer's machine they are the work.
 */
export const SYSTEM_PORTS: ReadonlySet<number> = new Set([
	22, // ssh
	25, // smtp
	53, // dns
	88, // kerberos
	111, // rpcbind
	123, // ntp
	137, 138, 139, // netbios
	445, // smb
	548, // afp
	631, // ipp/cups
	3283, // apple remote desktop
	5353, // mdns
	5900, // vnc
	// macOS hands 5000 and 7000 to ControlCenter for AirPlay. They look exactly
	// like a dev server, and on this machine they were the two most confusing
	// rows in the list.
	5000, 7000,
]);

/**
 * Processes whose listening ports are never somebody's service.
 *
 * Matched case-insensitively on the whole executable name — never as a substring,
 * because `node` appears inside plenty of names a developer does own.
 *
 * ⚠ A BROWSER BELONGS HERE. Chrome's remote-debugging port is not infrastructure
 * and not a dev server, but forwarding it hands over every open tab, every cookie
 * and anything being typed into a password field. It is folded by name rather
 * than by port because the port is configurable and the danger is not.
 */
export const SYSTEM_PROCESSES: ReadonlySet<string> = new Set([
	// macOS
	'controlcenter',
	'rapportd',
	'sharingd',
	'airplayxpchelper',
	'remoted',
	'mdnsresponder',
	'netbiosd',
	'identityservicesd',
	'launchd',
	// linux
	'systemd',
	'systemd-resolve',
	'systemd-resolved',
	'sshd',
	'cupsd',
	'avahi-daemon',
	'chronyd',
	'rpcbind',
	'dnsmasq',
	'networkmanager',
	// browsers — see the warning above
	'google chrome',
	'google chrome helper',
	'chromium',
	'firefox',
	'safari',
	'msedge',
	'microsoft edge',
]);

function normalisePort(value: unknown): number | null {
	const port = Math.trunc(Number(value));
	return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Why this port is folded, or `null` to show it. */
export function foldReason(entry: ListenerInput): FoldReason | null {
	const port = normalisePort(entry?.port);
	if (port === null) return null;
	if (SYSTEM_PORTS.has(port)) return 'system-port';
	if (SYSTEM_PROCESSES.has(String(entry?.process ?? '').trim().toLowerCase())) return 'system-process';
	// Checked last so a named system process on a high port reads as what it is
	// rather than as "the kernel picked this".
	if (port >= EPHEMERAL_PORT_MIN) return 'ephemeral';
	return null;
}

/**
 * Split the discovered ports into the ones worth showing and the ones to fold.
 *
 * ⚠ PORTS ALREADY REGISTERED AS SERVICES ARE DROPPED FROM BOTH. They are on the
 * services table directly above this one, with a probe result and a link — which
 * is strictly more than this table can say about them. Listing them twice makes
 * the shorter list look like the authoritative one. What is left is therefore
 * exactly the question this section answers: what is running here that pdmux does
 * not know about yet.
 */
export function discoveredPorts(
	listeners: readonly ListenerInput[] | null | undefined,
	registeredPorts: Iterable<number> | null | undefined = [],
): DiscoveredPorts {
	const registered = new Set<number>();
	for (const value of registeredPorts ?? []) {
		const port = normalisePort(value);
		if (port !== null) registered.add(port);
	}

	const seen = new Set<number>();
	const shown: DiscoveredPort[] = [];
	const folded: DiscoveredPort[] = [];

	for (const entry of Array.isArray(listeners) ? listeners : []) {
		const port = normalisePort(entry?.port);
		if (port === null || registered.has(port) || seen.has(port)) continue;
		seen.add(port);

		const reason = foldReason(entry);
		const item: DiscoveredPort = {
			port,
			process: String(entry?.process ?? '').trim(),
			// Absent means unknown, and the safe reading of unknown exposure is the
			// one that does not promise the port is confined to the host.
			loopbackOnly: entry?.loopbackOnly === true,
			folded: reason,
		};
		(reason === null ? shown : folded).push(item);
	}

	shown.sort((a, b) => a.port - b.port);
	folded.sort((a, b) => a.port - b.port);
	return { shown, folded };
}

/**
 * Narrow the list to what a person typed.
 *
 * Matches a port by the digits it contains rather than by prefix — on a machine
 * running four databases the useful query is "543", and a prefix match would
 * find 5432 but not 15432, which is the one they are actually looking for.
 * Process names match case-insensitively on a substring for the same reason.
 *
 * ⚠ THE CALLER MUST SEARCH THE FOLDED PORTS TOO. Folding is a guess about what
 * is worth showing FIRST; it is not a claim that those ports do not exist. A
 * search that only looks at the visible half answers "no results" for a port
 * that is right there, which is precisely the "this tool is broken" reaction the
 * fold was designed to avoid — and the person goes back to ssh. This function
 * filters whatever it is given, so give it everything.
 */
export function filterPorts(
	ports: readonly DiscoveredPort[] | null | undefined,
	query: unknown,
): DiscoveredPort[] {
	const rows = Array.isArray(ports) ? ports.filter(Boolean) : [];
	const needle = String(query ?? '').trim().toLowerCase();
	if (!needle) return [...rows];
	return rows.filter(
		(row) => String(row.port).includes(needle) || row.process.toLowerCase().includes(needle),
	);
}

/** Longest label the API accepts for a service. */
const LABEL_MAX = 64;

/**
 * A label for promoting a discovered port into a service.
 *
 * The port is part of the name rather than a fallback: a host running four
 * postgres instances is the ordinary case on a developer's machine, and
 * `postgres` alone would collide with the second one. Labels are unique per host
 * and the API rejects a duplicate, so the suffix loop is what keeps the button
 * from opening a dialog that cannot be submitted.
 */
export function suggestServiceLabel(
	entry: ListenerInput,
	taken: Iterable<string> | null | undefined = [],
): string {
	const port = normalisePort(entry?.port);
	const slug = String(entry?.process ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	const base = (slug ? `${slug}-${port ?? 0}` : `port-${port ?? 0}`).slice(0, LABEL_MAX);
	const used = new Set<string>();
	for (const value of taken ?? []) used.add(String(value ?? '').trim().toLowerCase());
	if (!used.has(base.toLowerCase())) return base;

	for (let suffix = 2; suffix < 100; suffix += 1) {
		const tail = `-${suffix}`;
		const candidate = `${base.slice(0, LABEL_MAX - tail.length)}${tail}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
	return base;
}
