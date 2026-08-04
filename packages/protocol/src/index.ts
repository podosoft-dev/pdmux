/**
 * @pdmux/protocol — the contract between an agent and the server.
 *
 * WHY IT IS ITS OWN PACKAGE: three programs have to agree on these shapes (the
 * NestJS API, the SvelteKit web app and the agent). Anything they disagree about
 * becomes a runtime surprise on someone else's machine, so the shapes live in one
 * place, are validated with zod at every boundary, and carry a version.
 *
 * COMPATIBILITY RULE (additive-only): add optional fields, never rename or remove
 * one, and never change a field's meaning. An agent is installed on machines you
 * may not be able to upgrade today; the server must keep understanding it. A
 * breaking change bumps PROTOCOL_VERSION and the server keeps the old reader.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/**
 * Version SEMANTICS live next to the version constant, and are re-exported here so a
 * consumer never has to know whether "is this agent old" is a frame question or a
 * string question. `PROTOCOL_VERSION` is the hard gate (the wire shape); the SemVer
 * comparison below is the soft one (which build is running).
 */
export {
	MIN_SUPPORTED_AGENT,
	agentVersionState,
	compareSemver,
	compareVersionStrings,
	parseSemver,
	type AgentVersionInput,
	type AgentVersionState,
	type Semver,
} from './semver.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Percentages are integers 0..100 — the UI never needs more resolution. */
export const percent = z.number().int().min(0).max(100);

/** Unix seconds. Every timestamp in this protocol is UTC seconds, never a string. */
export const epochSeconds = z.number().int().nonnegative();

/**
 * A terminal multiplexer session on the host (tmux today; the shape is generic on
 * purpose — `attached` and `windows` are what a target picker needs to show).
 */
export const muxSessionSchema = z.object({
	name: z.string().min(1).max(128),
	attached: z.number().int().nonnegative().default(0),
	windows: z.number().int().nonnegative().default(0),
});
export type MuxSession = z.infer<typeof muxSessionSchema>;

/**
 * One usage window reported by a coding agent (e.g. a session window and a weekly
 * window).
 *
 * BOTH POLARITIES TRAVEL: providers disagree — one reports what is left, the other
 * what is spent — and a card should always draw "remaining". Keeping both means a
 * tooltip can show the number the provider's own UI shows.
 */
export const usageWindowSchema = z.object({
	/** Stable key chosen by the provider adapter, e.g. `session`, `weekly`. */
	key: z.string().min(1).max(32),
	/** Fallback label for a UI with no translation for `key`. */
	label: z.string().max(64).optional(),
	usedPct: percent.nullable().default(null),
	remainingPct: percent.nullable().default(null),
	/** When this window resets. A window whose reset already passed is dropped. */
	resetsAt: epochSeconds.nullable().default(null),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const agentUsageSchema = z.object({
	/** Provider id, e.g. the CLI's binary name. The core stays provider-neutral. */
	provider: z.string().min(1).max(32),
	/** Live process count for that provider (exact name match, not a cmdline grep). */
	processes: z.number().int().nonnegative().default(0),
	/** When the numbers were taken — a stale snapshot is dimmed, not hidden. */
	ts: epochSeconds.nullable().default(null),
	windows: z.array(usageWindowSchema).max(8).default([]),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/** Result of probing one registered service port on the host. */
export const serviceProbeSchema = z.object({
	/** Server-assigned service id, echoed back so the UI can join without guessing. */
	id: z.string().uuid(),
	status: z.enum(['up', 'down', 'unknown']).default('unknown'),
	latencyMs: z.number().int().nonnegative().nullable().default(null),
});
export type ServiceProbe = z.infer<typeof serviceProbeSchema>;

/**
 * A TCP port the host is currently listening on — discovered, not registered.
 * The point is to spare somebody `lsof` on the box before they can register a
 * service: the dev server they just started is already in this list.
 *
 * ⚠ NO PID, DELIBERATELY. A pid is useless on a screen — it is not stable across
 * a restart and nothing here can act on it — and shipping the host's process
 * table to a remote dashboard is a wider disclosure than this product needs to
 * make. The process NAME is what a person reads the row by.
 *
 * `loopbackOnly` is not decoration either: a service bound to 127.0.0.1 is very
 * often unauthenticated precisely because its author reasoned nothing off-box
 * can reach it. Anything that later forwards a port has to see that bit.
 */
export const listenerSchema = z.object({
	port: z.number().int().min(1).max(65535),
	/** Executable name, not a command line — an argv can carry a token. */
	process: z.string().max(64).default(''),
	/** Bound to loopback only, so nothing off the host reaches it today. */
	loopbackOnly: z.boolean().default(false),
});
export type Listener = z.infer<typeof listenerSchema>;

// ---------------------------------------------------------------------------
// Heartbeat — what a host looks like right now
// ---------------------------------------------------------------------------

/**
 * Resource usage. Absolute bytes travel WITH the percentages: a tooltip wants
 * "12Gi/30Gi" and a percentage alone cannot produce it.
 */
export const resourceSchema = z.object({
	cpuPct: percent.nullable().default(null),
	memPct: percent.nullable().default(null),
	diskPct: percent.nullable().default(null),
	memUsedBytes: z.number().nonnegative().nullable().default(null),
	memTotalBytes: z.number().nonnegative().nullable().default(null),
	diskUsedBytes: z.number().nonnegative().nullable().default(null),
	diskTotalBytes: z.number().nonnegative().nullable().default(null),
	load1: z.number().nonnegative().nullable().default(null),
	uptimeSec: z.number().int().nonnegative().nullable().default(null),
});
export type Resource = z.infer<typeof resourceSchema>;

/**
 * Something the agent cannot fix by itself and the operator should see: git is
 * missing, the state directory is unwritable, the PTY fell back to a limited
 * mode. Without this it only shows up in `doctor` output on the host — which
 * nobody runs until they already suspect a problem.
 */
export const agentDiagnosticSchema = z.object({
	level: z.enum(['info', 'warn', 'error']).default('info'),
	/** Stable code so a UI can translate it; the message is the fallback. */
	code: z.string().min(1).max(64),
	message: z.string().max(512).default(''),
});
export type AgentDiagnostic = z.infer<typeof agentDiagnosticSchema>;

export const heartbeatSchema = z.object({
	ts: epochSeconds,
	resource: resourceSchema.default({}),
	sessions: z.array(muxSessionSchema).max(256).default([]),
	usage: z.array(agentUsageSchema).max(16).default([]),
	services: z.array(serviceProbeSchema).max(64).default([]),
	/**
	 * Ports discovered listening on the host.
	 *
	 * ⚠ NO `.default([])`, AND THAT IS THE WHOLE POINT. An agent older than this
	 * field omits the key; a current agent always sends the array, empty or not.
	 * A default would fill the absence in during parsing and the two would become
	 * the same value — which is exactly what happened before this comment existed:
	 * a host running a pre-listeners agent was stored with `listeners: []` and the
	 * dashboard told its owner "nothing is listening on this host", which was a
	 * claim nobody had made. Absent means "this agent does not report ports";
	 * empty means "it looked and found none". Keep them apart all the way to the
	 * screen.
	 *
	 * ⚠ THE CAP IS A REJECTION, NOT A TRUNCATION. Exceeding it fails the whole
	 * heartbeat, which would take the host's resource bars and sessions down
	 * with it. The agent truncates to this number before sending.
	 */
	listeners: z.array(listenerSchema).max(128).optional(),
	/** Degraded capabilities on the host — surfaced on the card, not just in logs. */
	diagnostics: z.array(agentDiagnosticSchema).max(16).default([]),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

// ---------------------------------------------------------------------------
// Git — read-only snapshots
// ---------------------------------------------------------------------------

export const gitRefSchema = z.object({
	name: z.string().min(1).max(255),
	kind: z.enum(['local', 'remote', 'tag']),
	sha: z.string().min(7).max(40),
	upstream: z.string().max(255).nullable().default(null),
	ahead: z.number().int().nonnegative().nullable().default(null),
	behind: z.number().int().nonnegative().nullable().default(null),
	/** Upstream branch no longer exists on the remote — a branch you can only push anew. */
	gone: z.boolean().default(false),
});
export type GitRef = z.infer<typeof gitRefSchema>;

/**
 * A row in the graph — and nothing more. The message body, the file list and the
 * patch are fetched when a commit is clicked: they were 58% of the feed when they
 * travelled with the list, and none of it is rendered before that click.
 */
export const gitCommitSchema = z.object({
	sha: z.string().min(7).max(40),
	parents: z.array(z.string().min(7).max(40)).max(16).default([]),
	refs: z.array(z.string().max(255)).max(64).default([]),
	author: z.string().max(255).default(''),
	date: epochSeconds.nullable().default(null),
	subject: z.string().max(1024).default(''),
});
export type GitCommit = z.infer<typeof gitCommitSchema>;

export const gitStatusFileSchema = z.object({
	path: z.string().max(1024),
	/** porcelain v2 index/worktree letters; `?` for untracked. */
	x: z.string().max(1).default(' '),
	y: z.string().max(1).default(' '),
});
export type GitStatusFile = z.infer<typeof gitStatusFileSchema>;

export const gitUncommittedSchema = z.object({
	staged: z.number().int().nonnegative().default(0),
	unstaged: z.number().int().nonnegative().default(0),
	untracked: z.number().int().nonnegative().default(0),
	conflicts: z.number().int().nonnegative().default(0),
	total: z.number().int().nonnegative().default(0),
	files: z.array(gitStatusFileSchema).max(500).default([]),
	/** Entries left out by the cap — a truncated list must not read as complete. */
	dropped: z.number().int().nonnegative().default(0),
	/**
	 * Submodule pointers that moved. Counted separately because a dirty submodule
	 * is invisible in the file list yet is exactly what makes a "clean" checkout
	 * commit something unexpected.
	 */
	submodules: z.number().int().nonnegative().default(0),
});
export type GitUncommitted = z.infer<typeof gitUncommittedSchema>;

export const gitHeadSchema = z.object({
	branch: z.string().max(255).nullable().default(null),
	sha: z.string().max(40).nullable().default(null),
	detached: z.boolean().default(false),
	upstream: z.string().max(255).nullable().default(null),
	ahead: z.number().int().nonnegative().nullable().default(null),
	behind: z.number().int().nonnegative().nullable().default(null),
});
export type GitHead = z.infer<typeof gitHeadSchema>;

/** One patched file inside a commit or working-tree diff. */
export const diffFileSchema = z.object({
	path: z.string().max(1024),
	oldPath: z.string().max(1024).nullable().default(null),
	status: z.enum(['A', 'M', 'D', 'R']).default('M'),
	add: z.number().int().nonnegative().default(0),
	del: z.number().int().nonnegative().default(0),
	binary: z.boolean().default(false),
	/** Clipped by the caps below; the flag keeps a partial patch honest. */
	truncated: z.boolean().default(false),
	lines: z.array(z.string()).default([]),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

/**
 * Caps the AGENT applies before anything crosses the wire. A browser renders this:
 * a single lock-file commit produced a multi-megabyte payload before the per-line
 * cap existed, because a line cap alone lets one 50,000-character line through.
 */
export const DIFF_CAPS = {
	maxBytes: 200_000,
	maxFileLines: 800,
	maxLineChars: 500,
} as const;

export const commitDetailSchema = z.object({
	sha: z.string().min(7).max(40),
	subject: z.string().max(1024).default(''),
	body: z.string().default(''),
	bodyTruncated: z.boolean().default(false),
	/**
	 * Who wrote it and who committed it.
	 *
	 * ⚠ ONLY WHAT THE ROW LACKS. `gitCommitSchema` already carries the author's
	 * name and date for the graph, and putting them here again would pay for the
	 * same bytes twice on the one payload this contract was already trimmed to keep
	 * small. A detail is only ever shown for a row the client is holding.
	 *
	 * ⚠ AND THE COMMITTER IS USUALLY THE AUTHOR. The pair differs after a rebase,
	 * a cherry-pick or a patch applied on somebody's behalf — which is exactly when
	 * it matters — so the UI draws the committer only when it differs, and its
	 * appearance is itself the signal.
	 */
	authorEmail: z.string().max(255).default(''),
	committer: z.string().max(255).default(''),
	committerEmail: z.string().max(255).default(''),
	committerDate: epochSeconds.nullable().default(null),
	files: z.array(diffFileSchema).default([]),
	/** Files left out by the byte cap — a count, so the UI can say how many. */
	dropped: z.number().int().nonnegative().default(0),
	truncated: z.boolean().default(false),
	/**
	 * A merge shown against its first parent usually has no patch. Storing that
	 * fact is what stops it being recomputed on every single pass.
	 */
	empty: z.boolean().default(false),
});
export type CommitDetail = z.infer<typeof commitDetailSchema>;

export const workingDiffSchema = z.object({
	staged: z.array(diffFileSchema).default([]),
	unstaged: z.array(diffFileSchema).default([]),
	untracked: z.array(diffFileSchema).default([]),
	dropped: z.number().int().nonnegative().default(0),
	truncated: z.boolean().default(false),
});
export type WorkingDiff = z.infer<typeof workingDiffSchema>;

/**
 * A ref as the REMOTE advertises it right now.
 *
 * ⚠ THIS IS NOT `gitRefSchema` AND THE DIFFERENCE IS THE POINT. That one is a
 * local ref — including `refs/remotes/*`, which is a remote-TRACKING ref and
 * therefore as old as the last fetch somebody ran. This one comes from asking the
 * remote itself, so it describes the remote at the moment of the check.
 *
 * ⚠ IT CARRIES A SHA AND NOT A DISTANCE. `ls-remote` downloads no objects, so
 * "the local ref points somewhere else" is knowable and "you are three commits
 * behind" is not. Anything that turns the first into the second is inventing a
 * number.
 */
export const gitRemoteRefSchema = z.object({
	name: z.string().max(255),
	sha: z.string().min(7).max(40),
	kind: z.enum(['branch', 'tag']).default('branch'),
});
export type GitRemoteRef = z.infer<typeof gitRemoteRefSchema>;

/** The result of one remote check, or the reason there is none. */
export const gitRemoteCheckSchema = z.object({
	checkedAt: epochSeconds,
	refs: z.array(gitRemoteRefSchema).max(2000).default([]),
	/** Set when the remote could not be reached — no remote, no network, no credentials. */
	error: z.string().max(512).nullable().default(null),
});
export type GitRemoteCheck = z.infer<typeof gitRemoteCheckSchema>;

/**
 * Caps for the two things a `File tree` view needs, which are NOT the diff's caps.
 *
 * ⚠ BYTES AND LINES BOTH, for the reason `DIFF_CAPS` records above: a line cap
 * alone lets one 50,000-character line through, and a minified bundle is exactly
 * that. A repository tree has no lines, so it is capped on entries.
 */
export const TREE_CAPS = {
	maxEntries: 5_000,
} as const;

export const BLOB_CAPS = {
	maxBytes: 256_000,
	maxLines: 4_000,
	maxLineChars: 500,
} as const;

/** One path in a repository as it stood at a commit. */
export const gitTreeEntrySchema = z.object({
	path: z.string().max(1024),
	/** Blob size in bytes, as `ls-tree --long` reports it. */
	size: z.number().int().nonnegative().default(0),
});
export type GitTreeEntry = z.infer<typeof gitTreeEntrySchema>;

export const gitTreeSchema = z.object({
	sha: z.string().min(7).max(40),
	entries: z.array(gitTreeEntrySchema).max(TREE_CAPS.maxEntries).default([]),
	/** Paths left out by the entry cap — a count, so the UI can say how many. */
	dropped: z.number().int().nonnegative().default(0),
	truncated: z.boolean().default(false),
	/** Set when the tree could not be read at all. */
	error: z.string().max(512).nullable().default(null),
});
export type GitTree = z.infer<typeof gitTreeSchema>;

/**
 * One file's contents at one commit.
 *
 * ⚠ `binary` IS AN ANSWER, NOT A FAILURE. A PNG has no lines to show and sending
 * its bytes to a browser that will render none of them is the payload this
 * contract keeps trimming. The UI says so instead.
 */
export const gitBlobSchema = z.object({
	sha: z.string().min(7).max(40),
	path: z.string().max(1024),
	lines: z.array(z.string().max(BLOB_CAPS.maxLineChars)).max(BLOB_CAPS.maxLines).default([]),
	binary: z.boolean().default(false),
	truncated: z.boolean().default(false),
	/** Size on disk, so "truncated" can say how much was left. */
	bytes: z.number().int().nonnegative().default(0),
	error: z.string().max(512).nullable().default(null),
});
export type GitBlob = z.infer<typeof gitBlobSchema>;

export const repoSnapshotSchema = z.object({
	/** Stable identity of the checkout on that host. */
	path: z.string().max(1024),
	/** Display name — the checkout's directory, or a submodule's path. */
	name: z.string().max(512),
	ts: epochSeconds,
	head: gitHeadSchema.default({}),
	refs: z.array(gitRefSchema).max(2000).default([]),
	commits: z.array(gitCommitSchema).max(1000).default([]),
	uncommitted: gitUncommittedSchema.nullable().default(null),
	/** True when the window hid older history. */
	truncated: z.boolean().default(false),
	limit: z.number().int().positive().default(300),
	/** Commit details produced in THIS pass (bounded by the server's budget). */
	details: z.array(commitDetailSchema).max(500).default([]),
	/** Working-tree patch, rewritten every pass; null once the tree is clean. */
	workingDiff: workingDiffSchema.nullable().default(null),
	/** Commits in the window that still have no detail anywhere — the UI says so. */
	pending: z.number().int().nonnegative().default(0),
	/**
	 * The last remote check, or null when nobody has asked for one.
	 *
	 * Never filled by the periodic pass: it costs a network round trip per
	 * repository, so it happens when a person presses the button and not on a timer.
	 */
	remote: gitRemoteCheckSchema.nullable().default(null),
	/**
	 * A repository's whole file list at one commit, and one file's contents.
	 *
	 * ⚠ NEVER FILLED BY THE PERIODIC PASS, for the same reason `remote` is not:
	 * the tree of a large checkout is thousands of paths and a blob is arbitrary
	 * bytes, and neither is worth collecting for a commit nobody has opened. Both
	 * arrive only because somebody clicked.
	 */
	tree: gitTreeSchema.nullable().default(null),
	blob: gitBlobSchema.nullable().default(null),
	/**
	 * True when this frame answers a `commitDetail` request and carries ONLY
	 * `details`. Without it, replying to one click costs a full graph rebuild
	 * (refs + every row) that the server already has.
	 */
	partial: z.boolean().default(false),
	error: z.string().max(512).nullable().default(null),
});
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;

// ---------------------------------------------------------------------------
// Terminal frames (WebSocket)
// ---------------------------------------------------------------------------

/**
 * What a terminal attaches to.
 *  - `session`: attach to (or create) a named multiplexer session — survives a
 *    dropped connection, which is why it is the default.
 *  - `shell`: a bare login shell — dies with the connection (the UI warns).
 */
export const terminalTargetSchema = z.object({
	kind: z.enum(['session', 'shell']).default('session'),
	/** Session name for `kind: 'session'`; ignored for `shell`. */
	session: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
	cols: z.number().int().positive().max(1000).default(80),
	rows: z.number().int().positive().max(500).default(24),
});
export type TerminalTarget = z.infer<typeof terminalTargetSchema>;

/** Browser -> server -> agent. */
export const terminalClientFrameSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('open'), termId: z.string().min(1).max(64), target: terminalTargetSchema }),
	z.object({ type: z.literal('input'), termId: z.string().min(1).max(64), data: z.string() }),
	z.object({
		type: z.literal('resize'),
		termId: z.string().min(1).max(64),
		cols: z.number().int().positive().max(1000),
		rows: z.number().int().positive().max(500),
	}),
	z.object({ type: z.literal('close'), termId: z.string().min(1).max(64) }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;

/** Agent -> server -> browser. */
export const terminalServerFrameSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready'), termId: z.string(), pid: z.number().int().nullable().default(null) }),
	z.object({
		type: z.literal('output'), termId: z.string(), data: z.string(),
		/**
		 * Bytes the producer had to drop to stay under its buffer cap. A runaway
		 * command (a build log, `yes`) outruns any consumer; dropping is the only
		 * option left, and saying how much keeps the pane honest instead of
		 * silently corrupting the stream.
		 */
		dropped: z.number().int().nonnegative().default(0),
	}),
	z.object({ type: z.literal('exit'), termId: z.string(), code: z.number().int().nullable().default(null) }),
	z.object({ type: z.literal('error'), termId: z.string(), message: z.string().max(512) }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

// ---------------------------------------------------------------------------
// Agent <-> server envelope
// ---------------------------------------------------------------------------

export const agentCapabilitySchema = z.enum([
	'metrics',
	'sessions',
	'terminal',
	'git',
	'usage',
	'services',
	/**
	 * Can run a single non-interactive command and report its exit code (`exec`
	 * frame). Absent from every agent built before it, which is exactly why the
	 * server must read this rather than assume — an old agent would silently
	 * ignore the frame and the caller would wait for an answer that never comes.
	 */
	'exec',
]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

/**
 * Whether this host can be updated FROM the dashboard, and by what.
 *
 * A remote update ends with the agent replacing its own binary and exiting; something
 * else has to start it again. Under systemd (`Restart=always`) or launchd
 * (`KeepAlive`) that is free and needs no privileges. With no service manager — run
 * from a terminal, or installed with `--no-service` — exiting is a hole the agent
 * never climbs out of, so the server must know NOT to offer the button.
 *
 * WHY A NEW OBJECT AND NOT A `capabilities` MEMBER: `capabilities` is a zod enum, so a
 * newer agent sending a member an older server does not know fails the element, fails
 * the array, and fails the whole `hello` — that host would silently vanish from the
 * dashboard. An unknown *field* is stripped; an unknown *enum value* is fatal.
 */
export const agentUpdateAbilitySchema = z.object({
	canRestart: z.boolean().default(false),
	restartMode: z.enum(['systemd', 'launchd', 'none']).default('none'),
});
export type AgentUpdateAbility = z.infer<typeof agentUpdateAbilitySchema>;

export const agentHelloSchema = z.object({
	protocolVersion: z.number().int().positive(),
	/**
	 * ⚠ FREE-FORM ON PURPOSE — do not tighten this to a SemVer pattern. This is
	 * validated on the frame an ALREADY-INSTALLED agent sends: a host reporting
	 * `0.1.0-dev+g1a2b3c` would fail `safeParse`, never reach `applyHello`, and
	 * disappear from the dashboard — and the fix for such a host is the update button
	 * on the screen it just vanished from. Strictness belongs in the reader
	 * (`parseSemver` → null → `unknown`), where being wrong costs a grey badge.
	 */
	agentVersion: z.string().max(32),
	hostname: z.string().max(255),
	/**
	 * Where this host can be reached, ANSWERED BY THE HOST ITSELF.
	 *
	 * ⚠ THE SERVER CANNOT WORK THIS OUT, which is why it is asked for here. What a
	 * server observes is the far end of the socket, and the agent dials OUT: measured
	 * on this deployment, one agent arrives as `127.0.0.1` (it is the same machine) and
	 * another as a container-bridge address belonging to the reverse proxy. Neither is a
	 * way back to the machine. The agent, standing on the host, can simply ask its own
	 * kernel which source address reaches the server — and that is an address on the
	 * route between them.
	 *
	 * EMPTY IS A REAL ANSWER, and the default keeps it that way for every agent built
	 * before this field existed. A `hello` that fails validation never reaches the
	 * registry and the host disappears from the dashboard, so a new key is only ever
	 * added with a default — the same reason `update` has one.
	 */
	address: z.string().max(255).default(''),
	os: z.string().max(64),
	arch: z.string().max(32),
	capabilities: z.array(agentCapabilitySchema).default([]),
	/** Absent from every agent built before remote update — the default says "no". */
	update: agentUpdateAbilitySchema.default({}),
});
export type AgentHello = z.infer<typeof agentHelloSchema>;

/**
 * Progress AND outcome of a remote update, in one type.
 *
 * WHO SENDS WHICH: `done` comes from the NEW binary once it has completed its own
 * handshake, and `rolledBack` from the OLD one after it restored itself. Every
 * outcome is therefore reported by an agent that is connected — the server never has
 * to infer failure from a silence, which is the reading that turns a slow host into a
 * false alarm.
 */
export const updateStatusSchema = z.object({
	/** Echoes `agentUpdate.commandId`, so a retry is recognisable as the same job. */
	commandId: z.string().uuid(),
	phase: z.enum([
		'accepted',
		'downloading',
		'verifying',
		'swapping',
		'restarting',
		'done',
		'failed',
		'rolledBack',
	]),
	progressPct: percent.nullable().default(null),
	/** What is running RIGHT NOW — authoritative, because the stored row can be stale. */
	currentVersion: z.string().max(32),
	targetVersion: z.string().max(32).nullable().default(null),
	/** Stable reason code (`SHA_MISMATCH`, `NOT_NEWER`, …) so a UI can group failures. */
	code: z.string().max(64).nullable().default(null),
	message: z.string().max(512).default(''),
	/**
	 * Sent with `accepted`, and the reason the confirmation dialog can talk in numbers:
	 * a restart terminates plain shells and their children, while multiplexer sessions
	 * survive and re-attach.
	 */
	shellPanes: z.number().int().nonnegative().default(0),
	sessionPanes: z.number().int().nonnegative().default(0),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/**
 * How much of one command's output travels back. 64 KiB each way.
 *
 * ⚠ NOT `sys.DefaultMaxOutput`. The agent caps a command at 32 MiB, which is the
 * right number for something it consumes locally and the wrong one for something
 * it puts on a websocket and a caller pastes into a model's context. Truncation is
 * therefore deliberate here, and `truncated` says it happened rather than leaving a
 * reader to wonder whether the build really stopped mid-line.
 */
export const EXEC_OUTPUT_MAX = 64_000;

/**
 * Run one command on the host and report how it went.
 *
 * WHY THIS EXISTS RATHER THAN DRIVING A TERMINAL: a PTY session hands back a
 * stream with the shell's prompt, its echo and ANSI in it, and — the part that
 * actually matters — NO EXIT CODE. A caller cannot tell a build that failed from
 * one that printed the word "error", which is precisely the judgement an automated
 * caller has to make. This frame trades interactivity for an answer.
 *
 * ⚠ `command` AND `args` ARE SEPARATE, AND THERE IS NO SHELL. A single string
 * would have to be handed to `sh -c`, and then every caller is one unquoted
 * variable away from running something else. The agent execs the binary directly
 * (`sys.Run` already takes file + args), so shell metacharacters are literal
 * arguments and nothing else.
 */
export const agentExecSchema = z.object({
	/** The server's id for this run; `execResult` echoes it. */
	commandId: z.string().uuid(),
	/** Binary name or absolute path. Resolved on the host, not here. */
	command: z.string().min(1).max(256),
	args: z.array(z.string().max(4096)).max(64).default([]),
	/** Absent means the agent's own working directory. */
	cwd: z.string().max(1024).nullable().default(null),
	/** Bounded on both ends: unbounded is how one call holds a slot forever. */
	timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
});
export type AgentExec = z.infer<typeof agentExecSchema>;

/**
 * The outcome of one `exec`.
 *
 * `exitCode` is `-1` when the process was killed or never started, which is the
 * convention `sys.Run` already uses — carried through rather than translated, so
 * the two sides cannot drift. `timedOut` distinguishes "we stopped it" from "it
 * failed", and `code` carries a stable reason when the agent refused before
 * running at all (`COMMAND_NOT_FOUND`).
 */
export const execResultSchema = z.object({
	commandId: z.string().uuid(),
	exitCode: z.number().int(),
	stdout: z.string().max(EXEC_OUTPUT_MAX).default(''),
	stderr: z.string().max(EXEC_OUTPUT_MAX).default(''),
	/** Either stream hit `EXEC_OUTPUT_MAX` and was cut. */
	truncated: z.boolean().default(false),
	timedOut: z.boolean().default(false),
	code: z.string().max(64).nullable().default(null),
	message: z.string().max(512).default(''),
});
export type ExecResult = z.infer<typeof execResultSchema>;

/** Agent -> server. */
export const agentUpstreamSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('hello'), hello: agentHelloSchema }),
	z.object({ type: z.literal('heartbeat'), heartbeat: heartbeatSchema }),
	z.object({ type: z.literal('repos'), ts: epochSeconds, repos: z.array(repoSnapshotSchema).max(64) }),
	z.object({ type: z.literal('terminal'), frame: terminalServerFrameSchema }),
	z.object({ type: z.literal('pong'), ts: epochSeconds }),
	z.object({ type: z.literal('updateStatus'), update: updateStatusSchema }),
	z.object({ type: z.literal('execResult'), result: execResultSchema }),
]);
export type AgentUpstream = z.infer<typeof agentUpstreamSchema>;

/**
 * Server -> agent. `config` is how the server steers an agent that is already
 * installed: intervals, which repos to watch, which ports to probe — none of it
 * requires touching the host again.
 */
export const agentServiceConfigSchema = z.object({
	id: z.string().uuid(),
	port: z.number().int().positive().max(65_535),
	probe: z.enum(['tcp', 'http', 'none']).default('tcp'),
	path: z.string().max(512).default('/'),
});
export type AgentServiceConfig = z.infer<typeof agentServiceConfigSchema>;

export const agentConfigSchema = z.object({
	heartbeatSec: z.number().int().min(1).max(3600).default(5),
	gitIntervalSec: z.number().int().min(10).max(86_400).default(120),
	/** Roots to scan for checkouts (the agent also walks one level of submodules). */
	gitRoots: z.array(z.string().max(1024)).max(32).default([]),
	gitLimit: z.number().int().min(10).max(2000).default(300),
	/** Max NEW commit details per repo per pass — this is what bounds a cold start. */
	gitDetailBudget: z.number().int().min(0).max(1000).default(120),
	services: z.array(agentServiceConfigSchema).max(64).default([]),
	usageProviders: z.array(z.string().max(32)).max(16).default([]),
	/** How often to re-read provider usage; it is far more expensive than a heartbeat. */
	usageIntervalSec: z.number().int().min(10).max(3600).default(60),
	/** Per-service probe timeout — a hung port must not delay the whole heartbeat. */
	probeTimeoutMs: z.number().int().min(100).max(10_000).default(2000),
	/** Cap on `git status` entries reported for one repo. */
	statusFileCap: z.number().int().min(10).max(2000).default(300),
	/** Cap on a stored commit message body. */
	bodyMaxChars: z.number().int().min(200).max(20_000).default(1200),
	/** Terminal output the agent may buffer per pane before it drops oldest bytes. */
	terminalBufferBytes: z.number().int().min(4096).max(4_000_000).default(262_144),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * "Replace yourself with this build."
 *
 * ⚠ THIS FRAME GRANTS NO NEW POWER, AND THAT IS A PROPERTY TO DEFEND, NOT A FACT TO
 * ASSUME. A server that can open a PTY on a host can already run anything there, so
 * remote update is a convenience over a capability it has. Two design choices are what
 * keep it that way, and both must survive future edits:
 *
 *  1. `artifactPath` IS A PATH, NEVER A URL. The agent joins it onto the origin in its
 *     own 0600 config — the one it authenticated to. Accepting an absolute URL would
 *     turn one frame into "make every host in the fleet fetch arbitrary bytes from an
 *     arbitrary host", using the fleet's egress identity. That is a new capability
 *     (SSRF), not a convenience. If a CDN is ever needed, it needs a HOST-side
 *     allow-list, so the host keeps the decision.
 *  2. THERE IS NO INSTALL-PATH FIELD. The agent swaps `os.Executable()` and nothing
 *     else. A server-chosen destination is an arbitrary-file-write primitive.
 *
 * `sha256` pins the bytes. Be honest about what that buys: the same server declares
 * the hash and serves the bytes, so it defends against a corrupted or swapped static
 * object — not against a compromised pdmux. Signature fields are deliberately absent
 * rather than half-done; adding `sig`/`sigAlg` later stays additive.
 */
export const agentUpdateSchema = z.object({
	/** Idempotency key. Re-sending the same id must not start a second download. */
	commandId: z.string().uuid(),
	/** SemVer of the target build. The agent refuses `<= own` unless `force`. */
	version: z.string().min(1).max(32),
	/**
	 * Path under the agent's OWN server origin. See (1) above.
	 *
	 * The shape is pinned HERE rather than only in the agent, so both languages get it
	 * for free and a server bug is rejected at the boundary instead of downloading:
	 *  - must start with `/` — a bare `https://…` cannot match, so no scheme,
	 *  - the second character may not be `/` — this is what stops `//evil.example/x`,
	 *    which is protocol-relative and would resolve against ANOTHER HOST,
	 *  - the character class excludes `:`, `?`, `#`, `@` and whitespace.
	 * Written without a lookahead on purpose: Go's RE2 has none, and a pattern the two
	 * runtimes read differently is worse than a slightly clumsier one.
	 *
	 * `..` still matches structurally; the agent rejects it separately. It is a
	 * clarity rule, not a boundary — the request cannot leave our own origin either way.
	 */
	artifactPath: z
		.string()
		.min(1)
		.max(512)
		.regex(/^\/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$/),
	/**
	 * Lower-case hex. This one IS pattern-checked, unlike `agentVersion`: a malformed
	 * hash is never a compatibility question, always a bug, and the field is new enough
	 * that no deployed agent has an opinion about it.
	 */
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	/** Exact size; also the agent's read cap, so a truncated or endless body stops. */
	bytes: z.number().int().positive().max(200_000_000),
	/** Echoed so the agent can refuse a build for the wrong machine before running it. */
	os: z.string().max(64),
	arch: z.string().max(32),
	/** Permits a deliberate downgrade. Still fully gated by verify-then-commit. */
	force: z.boolean().default(false),
	/** How long the new binary has to complete a handshake before it rolls itself back. */
	probationSec: z.number().int().min(30).max(1800).default(300),
});
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;

export const agentDownstreamSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('welcome'),
		hostId: z.string().uuid(),
		config: agentConfigSchema,
		/** Server's own SemVer. Advisory — logged by the agent, never a gate. */
		serverVersion: z.string().max(32).default(''),
		/**
		 * When the token this connection authenticated with stops working, ISO-8601.
		 *
		 * OPTIONAL AND ABSENT MEANS NEVER, which is what every host minted before
		 * agent tokens had an expiry gets — so this is purely additive and
		 * `PROTOCOL_VERSION` stays 1. An older agent ignores an unknown field; a
		 * newer agent against an older server simply never sees one.
		 *
		 * ⚠ IT IS A NOTICE, NOT A GATE. The server refuses an expired token at the
		 * upgrade, and that refusal is the enforcement. This exists so the agent can
		 * write the date into its own status output — otherwise the only symptom of
		 * a lapsed credential is a machine that reconnects forever with a 401 nobody
		 * is looking at, which is the failure this whole feature had to answer for.
		 */
		tokenExpiresAt: z.string().max(40).optional(),
	}),
	z.object({ type: z.literal('config'), config: agentConfigSchema }),
	z.object({ type: z.literal('update'), update: agentUpdateSchema }),
	z.object({ type: z.literal('exec'), exec: agentExecSchema }),
	z.object({ type: z.literal('terminal'), frame: terminalClientFrameSchema }),
	z.object({ type: z.literal('ping'), ts: epochSeconds }),
	/**
	 * "Do a pass now." `remote` is the odd one: it leaves the machine, so it is
	 * never on the agent's own timer and only ever arrives because somebody pressed
	 * a button.
	 */
	z.object({ type: z.literal('collect'), what: z.enum(['heartbeat', 'repos', 'remote']) }),
	z.object({
		type: z.literal('commitDetail'),
		repoPath: z.string().max(1024),
		shas: z.array(z.string().min(7).max(40)).max(50),
	}),
	/**
	 * "What files existed at this commit", and "what is in this one".
	 *
	 * ⚠ TWO FRAMES, NOT ONE WITH AN OPTIONAL PATH. They cost different things —
	 * a tree is one `ls-tree` and a blob is one `show` per click — and folding
	 * them together would mean re-reading the tree every time somebody opened
	 * another file in it.
	 */
	z.object({
		type: z.literal('fileTree'),
		repoPath: z.string().max(1024),
		sha: z.string().min(7).max(40),
	}),
	z.object({
		type: z.literal('fileContent'),
		repoPath: z.string().max(1024),
		sha: z.string().min(7).max(40),
		path: z.string().max(1024),
	}),
	/**
	 * "I have these." Details are immutable per sha, so an agent that knows what
	 * the server already stored never rebuilds them — without this, a restarted
	 * agent spends its whole per-pass budget re-producing patches the server has.
	 */
	z.object({
		type: z.literal('detailAck'),
		repoPath: z.string().max(1024),
		shas: z.array(z.string().min(7).max(40)).max(1000),
	}),
]);
export type AgentDownstream = z.infer<typeof agentDownstreamSchema>;

/** Header carrying the agent's key on the WebSocket upgrade and the REST fallback. */
export const AGENT_KEY_HEADER = 'x-api-key';
/** Path an agent dials. Kept here so the agent and the gateway cannot drift. */
export const AGENT_WS_PATH = '/agent/ws';
/** Path a browser dials for a terminal; the server relays it to the agent. */
export const TERMINAL_WS_PATH = '/terminal/ws';

/**
 * Why a connection was refused — the one vocabulary the server's aggregate and
 * the agent's local record both speak.
 *
 * ⚠ THIS IS AN INTERNAL VOCABULARY, NOT A RESPONSE BODY. What goes back to a
 * caller stays exactly as opaque as it is today: one 401 for missing, unknown,
 * revoked and expired alike. A refusal that said WHICH is an oracle telling an
 * attacker whether a token exists, and telling them when a real one has lapsed.
 * These names travel two other ways instead — into the server's own aggregate,
 * and (as a close code the agent already receives) into the file the agent
 * leaves on its own disk.
 *
 * ⚠ AND THE TWO SIDES SEE DIFFERENT SUBSETS. `missing_key` and `unknown` are
 * decided before an upgrade completes, so the agent sees only an HTTP status
 * there and cannot tell them apart; `revoked`, `host_disabled` and
 * `host_deleted` arrive as close codes on a socket that was already accepted.
 * Both sides are honest about what they could actually observe rather than
 * guessing the rest.
 */
export const AGENT_REFUSAL_REASONS = [
	'missing_key',
	'unknown',
	'revoked',
	'expired',
	'host_disabled',
	'host_deleted',
] as const;
export type AgentRefusalReason = (typeof AGENT_REFUSAL_REASONS)[number];

/**
 * Close codes the gateway sends an agent it has already accepted.
 *
 * Kept beside the reasons because the agent learns the reason FROM the code —
 * they are one fact expressed twice, and drift between them is what makes a
 * refused agent look like a network blip.
 *
 * ⚠ 4001 IS DELIBERATELY ABSENT: the terminal relay uses it toward browsers.
 */
export const AGENT_CLOSE_REPLACED = 4000;
export const AGENT_CLOSE_HOST_DISABLED = 4002;
export const AGENT_CLOSE_TOKEN_REVOKED = 4003;
export const AGENT_CLOSE_HOST_DELETED = 4004;

/**
 * Parse an untrusted frame without throwing — every boundary in this system
 * receives bytes from another machine, and one malformed frame must not take a
 * connection (or a collector pass) down with it.
 */
export function safeParse<T extends z.ZodTypeAny>(
	schema: T,
	value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
	const result = schema.safeParse(value);
	if (result.success) return { ok: true, data: result.data };
	const first = result.error.issues[0];
	const where = first?.path.join('.') || '(root)';
	return { ok: false, error: `${where}: ${first?.message ?? 'invalid'}` };
}
