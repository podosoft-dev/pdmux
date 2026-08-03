/**
 * Read-only commit graph: lane assignment and row/edge geometry.
 *
 * LANE MODEL (following the vscode-git-graph approach): walk the commits in feed
 * order (`--date-order`), keep an array of active lanes where each lane holds "the
 * sha we are waiting to draw next", and:
 *   - a commit takes the leftmost lane already waiting for it (its child drew it),
 *     or a new lane when nothing waits for it (a branch tip);
 *   - its FIRST parent continues that lane; every other parent claims another lane
 *     (a merge fans out to the right);
 *   - a lane whose commit never arrives (history cut off by the feed window) ends as
 *     an `open` edge, drawn faded — we do not invent a line to nowhere.
 *
 * Everything here is pure: no DOM, no fetch, no repository access. Nothing in this
 * package can change a repository — there is no checkout, merge, rebase or fetch.
 */

/** Lane palette — index modulo length, like vscode-git-graph's colour cycling. */
export const LANE_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#dc2626'] as const;

/**
 * Row height / lane width in SVG user units (1 unit = 1px at default zoom).
 *
 * ⚠ `row` is a DEFAULT, not the truth. How tall a row really is belongs to CSS
 * (`--pdmux-row`, which `@media (pointer: coarse)` raises to 40px so a finger can hit
 * one commit), and the caller measures it and passes it in. Treating 24 as a constant
 * is what made the SVG `24n` tall while the list beside it was `40n`: the overlay ran
 * out ~60% of the way down and every row below it had no lane and no dot at all.
 *
 * `pad` is the HORIZONTAL gutter only. The vertical offset is half a row — see `rowGeom`.
 */
export const GEOM = { row: 24, lane: 14, dot: 3.5, pad: 8 } as const;

/**
 * Resolve the row height a caller asked for, and the vertical offset that centres a
 * dot in its row.
 *
 * Half a row rather than `GEOM.pad`: a dot marks a ROW, so it belongs on that row's
 * centre line. The old fixed 8 put it 4px high at 24px rows — invisible enough to
 * survive, and 12px high at 40px rows, which is not.
 */
function rowGeom(rowHeight?: number): { row: number; padY: number } {
	const row = typeof rowHeight === 'number' && Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : GEOM.row;
	return { row, padY: row / 2 };
}

/** The pseudo-commit for working-tree changes, pinned above HEAD. */
export const UNCOMMITTED = 'uncommitted';

export const laneColor = (lane: number): string =>
	LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length] as string;

export interface GraphCommitInput {
	sha: string;
	parents?: readonly string[];
}

export interface GraphRow {
	sha: string;
	kind: 'commit' | 'uncommitted';
	lane: number;
	color: string;
	row: number;
	x: number;
	y: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	fromLane: number;
	toLane: number;
	color: string;
	/** The parent is outside the feed window — draw a faded stub, not a line. */
	open?: boolean;
	/** The working-tree link, drawn dashed. */
	dashed?: boolean;
}

export interface GraphLayout {
	rows: GraphRow[];
	edges: GraphEdge[];
	lanes: number;
}

/**
 * Assign lanes and edges to a commit list (newest first).
 *
 * @param opts.uncommitted adds a first row for the working tree, linked to `head`
 * @param opts.head the sha the working tree sits on
 * @param opts.rowHeight the rendered height of one row; defaults to `GEOM.row`
 */
export function layoutGraph(
	commits: unknown,
	opts: { uncommitted?: boolean; head?: string | null; rowHeight?: number } = {},
): GraphLayout {
	const { row: rowH, padY } = rowGeom(opts.rowHeight);
	const list = (Array.isArray(commits) ? commits : []).filter(
		(c): c is GraphCommitInput => Boolean(c) && typeof (c as GraphCommitInput).sha === 'string',
	);
	const rows: GraphRow[] = [];
	const edges: GraphEdge[] = [];
	// lanes[i] = the sha that lane is waiting for, or null when free.
	const lanes: Array<string | null> = [];
	let maxLanes = 0;

	const claim = (sha: string): number => {
		// Reuse a lane already waiting for this sha, else the first free one, else grow.
		let index = lanes.indexOf(sha);
		if (index === -1) index = lanes.indexOf(null);
		if (index === -1) index = lanes.length;
		lanes[index] = sha;
		maxLanes = Math.max(maxLanes, lanes.length);
		return index;
	};
	const pos = (lane: number, row: number): { x: number; y: number } => ({
		x: GEOM.pad + lane * GEOM.lane,
		y: rowH * row + padY,
	});

	const known = new Set(list.map((c) => c.sha));
	let row = 0;

	if (opts.uncommitted) {
		// The working tree hangs off HEAD: same lane, dashed edge, always first.
		const head = typeof opts.head === 'string' && opts.head ? opts.head : list[0]?.sha;
		const lane = claim(head ?? UNCOMMITTED);
		rows.push({ sha: UNCOMMITTED, kind: 'uncommitted', lane, color: laneColor(lane), row, ...pos(lane, row) });
		if (head) {
			edges.push({ from: UNCOMMITTED, to: head, fromLane: lane, toLane: lane, color: laneColor(lane), dashed: true });
		}
		row += 1;
	}

	for (const commit of list) {
		const lane = claim(commit.sha);
		rows.push({ sha: commit.sha, kind: 'commit', lane, color: laneColor(lane), row, ...pos(lane, row) });
		// Free EVERY lane waiting for this sha, not just the one we drew in: two
		// children of the same parent each reserved a lane, and leaving the extra
		// reservation behind leaks lanes (the graph stays wide forever).
		for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.sha) lanes[i] = null;
		const parents = Array.isArray(commit.parents) ? commit.parents : [];
		parents.forEach((parent, i) => {
			// The first parent stays in the lane; the others fan out.
			let parentLane: number;
			if (i === 0) {
				lanes[lane] = parent;
				parentLane = lane;
			} else {
				parentLane = claim(parent);
			}
			edges.push({
				from: commit.sha,
				to: parent,
				fromLane: lane,
				toLane: parentLane,
				color: laneColor(parentLane),
				open: !known.has(parent), // history beyond the feed window
			});
		});
		// Trim trailing free lanes so the graph does not stay wide after a merge.
		while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
		row += 1;
	}

	// Second pass: an edge must end at the lane its parent REALLY got. The lane
	// reserved when the child was drawn is only a hint — the parent may be claimed by
	// an earlier sibling and land further left, and drawing to the reservation made
	// the rejoin line stop beside the dot instead of on it.
	const laneOf = new Map(rows.map((r) => [r.sha, r.lane]));
	for (const edge of edges) {
		const real = laneOf.get(edge.to);
		if (real != null) {
			edge.toLane = real;
			edge.color = laneColor(real);
		}
	}
	return { rows, edges, lanes: Math.max(1, maxLanes) };
}

/**
 * SVG path for one edge, in the same user space as `layoutGraph` positions.
 *
 * The endpoints come from the ROWS, not from a recomputed `y` — the layout already
 * placed them at whatever row height it was given, so an edge cannot land somewhere
 * its own dots are not even if a caller passes a different `rowHeight` here. Only the
 * curve's control offsets read `rowHeight`, where being wrong costs a shallow bend.
 */
export function edgePath(edge: GraphEdge, rows: readonly GraphRow[], rowHeight?: number): string {
	const from = rows.find((r) => r.sha === edge.from);
	const to = rows.find((r) => r.sha === edge.to);
	if (!from) return '';
	const { row } = rowGeom(rowHeight);
	const x = (lane: number): number => GEOM.pad + lane * GEOM.lane;
	const x1 = x(edge.fromLane);
	const y1 = from.y;
	// Parent outside the window: stop half a row below, faded (see `open`).
	if (!to) return `M${x1} ${y1} L${x1} ${y1 + row * 0.7}`;
	const x2 = x(edge.toLane);
	const y2 = to.y;
	if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`;
	// Curve out of the lane, then straight down — readable at a 24px row.
	const mid = y1 + row * 0.6;
	return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${Math.min(y2, mid + row * 0.4)} L${x2} ${y2}`;
}

/**
 * Full graph box, so a UI can size the SVG without measuring it.
 *
 * The height is EXACTLY the row stack's height (`rowHeight × rows`), because the SVG
 * is an absolute overlay on that stack: any other value is a region of the list the
 * graph does not reach. It used to add `pad * 2`, which made the box 16px taller than
 * the thing it covered — harmless only because the excess was at the bottom.
 */
export function graphSize(layout: GraphLayout, rowHeight?: number): { width: number; height: number } {
	const { row } = rowGeom(rowHeight);
	return {
		width: GEOM.pad * 2 + Math.max(1, layout.lanes) * GEOM.lane,
		height: row * layout.rows.length,
	};
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export type RefKind = 'local' | 'remote' | 'tag';
export type ChipKind = RefKind | 'head';

export interface RefChip {
	label: string;
	kind: ChipKind;
}

export interface RefInput {
	name: string;
	kind: RefKind;
	sha?: string;
	ahead?: number | null;
	behind?: number | null;
	gone?: boolean;
}

/**
 * Decoration strings from a commit row -> typed chips.
 *
 * A slash does NOT mean remote: `feat/x` and `legacy/main-20260715` are local
 * branches. Remote-ness is decided by the known remote names, which is the only
 * reliable signal.
 */
export function refChips(refs: unknown, remotes?: Iterable<string> | null): RefChip[] {
	const known = remotes instanceof Set ? remotes : new Set(remotes ? Array.from(remotes) : ['origin']);
	const out: RefChip[] = [];
	for (const raw of Array.isArray(refs) ? refs : []) {
		const text = String(raw).trim();
		if (!text) continue;
		if (text.startsWith('HEAD -> ')) out.push({ label: text.slice(8), kind: 'head' });
		else if (text === 'HEAD') out.push({ label: 'HEAD', kind: 'head' });
		else if (text.startsWith('tag: ')) out.push({ label: text.slice(5), kind: 'tag' });
		else if (known.has(text.split('/')[0] as string)) out.push({ label: text, kind: 'remote' });
		else out.push({ label: text, kind: 'local' });
	}
	return out;
}

/** Remote names present in a snapshot's refs (`origin/main` -> `origin`). */
export function remoteNames(refs: unknown): Set<string> {
	const out = new Set<string>();
	for (const ref of Array.isArray(refs) ? refs : []) {
		const candidate = ref as Partial<RefInput> | null;
		if (candidate?.kind === 'remote' && typeof candidate.name === 'string' && candidate.name.includes('/')) {
			out.add(candidate.name.split('/')[0] as string);
		}
	}
	return out;
}

/** Branch/tag panel grouping, sorted so the interesting things are on top. */
export function groupRefs(refs: unknown): Record<RefKind, RefInput[]> {
	const groups: Record<RefKind, RefInput[]> = { local: [], remote: [], tag: [] };
	for (const raw of Array.isArray(refs) ? refs : []) {
		const ref = raw as RefInput | null;
		if (!ref || !ref.kind || !(ref.kind in groups) || typeof ref.name !== 'string') continue;
		groups[ref.kind].push(ref);
	}
	// Local branches: diverged first (that is what needs attention), then by name.
	groups.local.sort(
		(a, b) => (b.ahead || 0) + (b.behind || 0) - ((a.ahead || 0) + (a.behind || 0)) || a.name.localeCompare(b.name),
	);
	groups.remote.sort((a, b) => a.name.localeCompare(b.name));
	groups.tag.sort((a, b) => b.name.localeCompare(a.name)); // newest-looking tags first
	return groups;
}

// ---------------------------------------------------------------------------
// Feed freshness, working tree, diffs
// ---------------------------------------------------------------------------

import { type RelativeAge, relativeAge } from './time.js';

export const FEED_STALE_MS = 10 * 60_000;

/** How old a snapshot is. An unknown timestamp counts as stale — it is a warning. */
export function feedAge(ts: unknown, now: number, staleMs = FEED_STALE_MS): RelativeAge {
	const age = relativeAge(ts, now, staleMs);
	return age.known ? age : { ...age, stale: true };
}

export type UncommittedKind = 'staged' | 'unstaged' | 'untracked' | 'conflicts';

export interface UncommittedSummary {
	parts: Array<{ kind: UncommittedKind; count: number }>;
	total: number;
}

/**
 * Structured summary of the working tree, or null when it is clean (the graph then
 * draws no working-tree row at all). Only non-zero kinds are returned, in a fixed
 * order, so a caller can join them with its own labels.
 */
export function uncommittedSummary(input: unknown): UncommittedSummary | null {
	if (!input || typeof input !== 'object') return null;
	const record = input as Partial<Record<UncommittedKind, number>>;
	const parts: UncommittedSummary['parts'] = [];
	let total = 0;
	for (const kind of ['staged', 'unstaged', 'untracked', 'conflicts'] as const) {
		const count = record[kind];
		if (typeof count === 'number' && count > 0) {
			parts.push({ kind, count });
			total += count;
		}
	}
	return parts.length ? { parts, total } : null;
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'meta' | 'ctx';

/** What a unified-diff line is, from its first character. */
export function diffLineKind(line: unknown): DiffLineKind {
	const text = String(line ?? '');
	if (text.startsWith('@@')) return 'hunk';
	if (text.startsWith('+')) return 'add';
	if (text.startsWith('-')) return 'del';
	if (text.startsWith('\\')) return 'meta'; // "\ No newline at end of file"
	return 'ctx';
}

export interface DiffFileTitle {
	status: 'A' | 'M' | 'D' | 'R' | '?';
	path: string;
	/** Set only for a rename, so a caller can render `old -> new`. */
	oldPath: string | null;
	binary: boolean;
	add: number;
	del: number;
	truncated: boolean;
}

/** Header data for one changed file: status, path (rename aware) and counts. */
export function diffFileTitle(file: unknown): DiffFileTitle {
	const input = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
	const status = input.status;
	return {
		status: status === 'A' || status === 'M' || status === 'D' || status === 'R' ? status : '?',
		path: typeof input.path === 'string' ? input.path : '',
		oldPath: typeof input.oldPath === 'string' && input.oldPath ? input.oldPath : null,
		binary: input.binary === true,
		add: typeof input.add === 'number' ? input.add : 0,
		del: typeof input.del === 'number' ? input.del : 0,
		truncated: input.truncated === true,
	};
}

/**
 * The shared vocabulary for "this commit has no patch (yet)".
 *
 * WHERE THE POLLING RULES ARE NOT: here. Whether a patch is coming and when to ask
 * again is about one app's HTTP endpoint and its own retry budget, so it lives beside
 * the code that makes those requests (`apps/web/src/lib/dashboard/commit-detail-retry.ts`)
 * — the same division as the terminal relay, whose reconnect backoff is app-owned too.
 * This package owns only what both sides RENDER, which is what keeps `@pdmux/ui` free of
 * any knowledge about how an app fetches.
 */
export interface PendingNote {
	/**
	 * `collecting` = it will appear; `missing` = it never will (say so differently);
	 * `timeout` = it was coming and we stopped waiting, so the user gets the decision.
	 */
	kind: 'collecting' | 'missing' | 'timeout';
	pending: number;
	shortSha: string;
}

/**
 * What to say when a clicked commit has no detail yet.
 *
 * "Not collected" and "being collected" are completely different information to a
 * user: the old flat wording made a temporary state read as a broken feature.
 */
export function pendingNote(snapshot: unknown, sha: unknown): PendingNote {
	const pendingRaw = (snapshot as { pending?: unknown } | null)?.pending;
	const pending = typeof pendingRaw === 'number' && Number.isFinite(pendingRaw) ? Math.max(0, pendingRaw) : 0;
	return {
		kind: pending > 0 ? 'collecting' : 'missing',
		pending,
		shortSha: String(sha ?? '').slice(0, 12),
	};
}
