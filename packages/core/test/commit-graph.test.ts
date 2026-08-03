/**
 * Commit-graph lanes, edges and the read-only view helpers.
 *
 * Two lane bugs were found by the original suite and are locked here: the first
 * parent must continue the lane, and an edge must end at the lane its parent really
 * got (a second pass), not at the lane its child reserved for it.
 */
import { describe, expect, it } from 'vitest';
import {
	GEOM,
	type GraphRow,
	LANE_COLORS,
	diffFileTitle,
	diffLineKind,
	edgePath,
	feedAge,
	graphSize,
	groupRefs,
	layoutGraph,
	pendingNote,
	refChips,
	remoteNames,
	uncommittedSummary,
} from '../src/index.js';

const c = (sha: string, ...parents: string[]): { sha: string; parents: string[] } => ({ sha, parents });
const laneOf = (layout: ReturnType<typeof layoutGraph>, sha: string): number =>
	layout.rows.find((r) => r.sha === sha)!.lane;

describe('[TC-PDCORE-060] a linear history stays in one lane', () => {
	it('steps one row height per commit and draws straight edges', () => {
		const g = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
		expect(g.lanes).toBe(1);
		expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		expect(g.rows.map((r) => r.row)).toEqual([0, 1, 2]);
		expect(g.rows[1]!.y - g.rows[0]!.y).toBe(GEOM.row);
		// A dot sits on its row's CENTRE line, so the first one is half a row down.
		expect(g.rows[0]!.y).toBe(GEOM.row / 2);
		expect(g.rows.every((r) => r.color === LANE_COLORS[0])).toBe(true);
		expect(g.edges).toHaveLength(2);
		expect(edgePath(g.edges[0]!, g.rows)).not.toContain('C');
		// The box is EXACTLY the row stack it overlays — no slack, or the overlay and the
		// list disagree about where the graph ends.
		expect(graphSize(g)).toEqual({ width: GEOM.pad * 2 + GEOM.lane, height: 3 * GEOM.row });
	});
});

describe('[TC-PDGIT-010] the feed order is the contract, and a wrong one is indistinguishable from a fork', () => {
	// Six commits, no merges, one root — the shape measured on `local-dev`, where the
	// API returned it with a pair transposed and it drew as three branches.
	const linear = [c('c1', 'c2'), c('c2', 'c3'), c('c3', 'c4'), c('c4', 'c5'), c('c5', 'c6'), c('c6')];

	it('draws a linear list in git order as ONE lane', () => {
		const g = layoutGraph(linear);
		expect(g.lanes).toBe(1);
		expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(g.rows.map((r) => r.sha)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
		expect(g.edges.every((e) => !e.open)).toBe(true);
	});

	it('opens a second lane for a parent handed over before its child — which is why the ORDER is fixed upstream', () => {
		// The same six commits with ONE pair transposed, exactly what ordering by
		// author date produced. `c4` now arrives while nothing is waiting for it, and
		// a commit nothing waits for IS a branch tip by this function's contract.
		const swapped = [linear[0]!, linear[1]!, linear[3]!, linear[2]!, linear[4]!, linear[5]!];
		expect(layoutGraph(swapped).lanes).toBe(2);

		// NO GUARD IS ADDED HERE, deliberately. From inside this function a real tip
		// and a misplaced parent are the same observation, so any repair would have to
		// re-topologise the feed — and would turn a genuine fork into a false straight
		// line the first time it was wrong. The order has ONE authority instead: the
		// window position the agent collected, stored by the API as `RepoCommit.seq`
		// rather than re-derived from a date that cannot reproduce it.
		//
		// Where the repair DOES live: `apps/api/src/git/commit-order.ts`, on the read that
		// owns the order. It re-topologises STABLY, which is the difference — a fork's two
		// tips are not ancestor-related, so nothing constrains them and their arrival order
		// is preserved. It runs there because `seq` is nullable, and a repo the agent has
		// stopped reporting falls back to a one-second `date` that ties.
		expect(layoutGraph([c('x', 'p'), c('y', 'p'), c('p')]).lanes).toBe(2);
	});
});

describe('[TC-PDCORE-061] a merge fans out and rejoins on the shared parent', () => {
	it('continues the merge lane with the first parent and frees lanes after the rejoin', () => {
		// m1 = merge(a2, f1); f1 and a2 both descend from a1.
		const g = layoutGraph([c('m1', 'a2', 'f1'), c('f1', 'a1'), c('a2', 'a1'), c('a1', 'a0'), c('a0')]);
		expect(g.lanes).toBe(2);
		expect(laneOf(g, 'm1')).toBe(0);
		expect(laneOf(g, 'f1')).toBe(1); // the second parent claims a new lane
		expect(laneOf(g, 'a2')).toBe(0); // the first parent continues the lane
		expect(laneOf(g, 'a1')).toBe(0); // the shared parent takes the leftmost waiting lane
		const cross = g.edges.filter((e) => e.fromLane !== e.toLane);
		expect(cross).toHaveLength(2); // fan-out and rejoin
		expect(cross.every((e) => edgePath(e, g.rows).includes('C'))).toBe(true);
		expect(laneOf(g, 'a0')).toBe(0); // lanes released, the graph does not stay wide
	});

	it('re-resolves an edge onto the lane its parent really got', () => {
		// Two siblings both reserve the same parent. Drawing to the reservation made
		// the rejoin line stop beside the dot instead of on it.
		const g = layoutGraph([c('x', 'p'), c('y', 'p'), c('p')]);
		const parentLane = laneOf(g, 'p');
		for (const edge of g.edges.filter((e) => e.to === 'p')) {
			expect(edge.toLane).toBe(parentLane);
			expect(edge.color).toBe(LANE_COLORS[parentLane % LANE_COLORS.length]);
		}
		// Every lane waiting for that sha is freed, so the graph narrows again.
		expect(layoutGraph([c('x', 'p'), c('y', 'p'), c('p', 'q'), c('q')]).lanes).toBe(2);
		expect(laneOf(layoutGraph([c('x', 'p'), c('y', 'p'), c('p', 'q'), c('q')]), 'q')).toBe(0);
	});
});

describe('[TC-PDCORE-062] an octopus merge claims one lane per extra parent', () => {
	it('cycles the palette by lane index', () => {
		const g = layoutGraph([c('o', 'p1', 'p2', 'p3', 'p4'), c('p1'), c('p2'), c('p3'), c('p4')]);
		expect(g.lanes).toBe(4);
		expect(g.edges.filter((e) => e.from === 'o').map((e) => e.toLane)).toEqual([0, 1, 2, 3]);
		const wide = layoutGraph([c('x', ...Array.from({ length: LANE_COLORS.length + 1 }, (_, i) => `p${i}`))]);
		expect(wide.edges.at(-1)!.color).toBe(LANE_COLORS[LANE_COLORS.length % LANE_COLORS.length]);
	});
});

describe('[TC-PDCORE-063] history beyond the window is a stub, and the working tree leads', () => {
	it('marks open edges, pins the uncommitted row first and survives junk', () => {
		const g = layoutGraph([c('a', 'older')]);
		expect(g.edges[0]!.open).toBe(true);
		expect(edgePath(g.edges[0]!, g.rows)).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);

		const wip = layoutGraph([c('h', 'g'), c('g')], { uncommitted: true, head: 'h' });
		expect(wip.rows[0]!.kind).toBe('uncommitted');
		expect(wip.rows[0]!.row).toBe(0);
		expect(wip.rows[0]!.lane).toBe(wip.rows[1]!.lane);
		const dashed = wip.edges.find((e) => e.dashed)!;
		expect([dashed.from, dashed.to]).toEqual(['uncommitted', 'h']);
		// No head given: the working-tree row still renders, hanging off the newest row.
		expect(layoutGraph([c('h')], { uncommitted: true }).rows[0]!.kind).toBe('uncommitted');
		expect(layoutGraph([], { uncommitted: true }).rows[0]!.kind).toBe('uncommitted');

		for (const input of [[], null, undefined, 'nope', [{}, { sha: 1 }]]) {
			const out = layoutGraph(input);
			expect(out.rows).toEqual([]);
			expect(out.edges).toEqual([]);
			expect(out.lanes).toBe(1);
		}
		expect(edgePath({ from: 'ghost', to: 'a', fromLane: 0, toLane: 0, color: '#000' }, g.rows)).toBe('');
	});
});

describe('[TC-PDCORE-067] ref chips are typed by the known remote names', () => {
	it('never treats a slash as a remote marker', () => {
		// `feat/x` and `legacy/main-20260715` are LOCAL branches; remote-ness comes
		// from the remote names in the snapshot.
		const remotes = remoteNames([
			{ kind: 'remote', name: 'origin/main' },
			{ kind: 'local', name: 'feat/x' },
		]);
		expect([...remotes]).toEqual(['origin']);
		expect(refChips(['HEAD -> main', 'origin/main', 'tag: v1.0.0', 'feat/x', 'HEAD', ''], remotes)).toEqual([
			{ label: 'main', kind: 'head' },
			{ label: 'origin/main', kind: 'remote' },
			{ label: 'v1.0.0', kind: 'tag' },
			{ label: 'feat/x', kind: 'local' },
			{ label: 'HEAD', kind: 'head' },
		]);
		expect(refChips(null)).toEqual([]);
		expect(remoteNames(null)).toEqual(new Set());

		const grouped = groupRefs([
			{ name: 'main', kind: 'local', ahead: 0, behind: 0 },
			{ name: 'feat/y', kind: 'local', ahead: 3, behind: 1 },
			{ name: 'origin/main', kind: 'remote' },
			{ name: 'v2', kind: 'tag' },
			{ name: 'junk', kind: 'nope' },
		]);
		expect(grouped.local.map((r) => r.name)).toEqual(['feat/y', 'main']); // diverged first
		expect(grouped.remote.map((r) => r.name)).toEqual(['origin/main']);
		expect(grouped.tag.map((r) => r.name)).toEqual(['v2']);
		expect(groupRefs(null)).toEqual({ local: [], remote: [], tag: [] });
	});
});

describe('[TC-PDCORE-068] the feed header says how old the snapshot is', () => {
	it('treats an unknown collection time as stale', () => {
		const now = 1_800_000_000_000;
		expect(feedAge(now / 1000 - 30, now)).toMatchObject({ unit: 'now', stale: false });
		expect(feedAge(now / 1000 - 300, now)).toMatchObject({ unit: 'minute', value: 5, stale: false });
		expect(feedAge(now / 1000 - 3600, now).stale).toBe(true);
		expect(feedAge(null, now)).toMatchObject({ known: false, stale: true });
	});
});

describe('[TC-PDCORE-069] a clean tree has no summary at all', () => {
	it('returns only the non-zero kinds, in a fixed order', () => {
		expect(uncommittedSummary({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0 })).toBeNull();
		expect(uncommittedSummary(null)).toBeNull();
		expect(uncommittedSummary({ staged: 1, unstaged: 2, untracked: 3, conflicts: 4 })).toEqual({
			parts: [
				{ kind: 'staged', count: 1 },
				{ kind: 'unstaged', count: 2 },
				{ kind: 'untracked', count: 3 },
				{ kind: 'conflicts', count: 4 },
			],
			total: 10,
		});
		expect(uncommittedSummary({ unstaged: 2 })!.parts).toEqual([{ kind: 'unstaged', count: 2 }]);
	});
});

describe('[TC-PDCORE-070] a diff line is classified by its first character', () => {
	it('never reports junk as a change, and describes a file header', () => {
		expect(
			['@@ -1,2 +1,3 @@', '+added', '-removed', ' context', '\\ No newline at end of file'].map(diffLineKind),
		).toEqual(['hunk', 'add', 'del', 'ctx', 'meta']);
		expect(diffLineKind(null)).toBe('ctx');

		expect(diffFileTitle({ status: 'A', path: 'x.ts', add: 5, del: 0 })).toEqual({
			status: 'A',
			path: 'x.ts',
			oldPath: null,
			binary: false,
			add: 5,
			del: 0,
			truncated: false,
		});
		expect(diffFileTitle({ status: 'R', oldPath: 'a', path: 'b', add: 1, del: 1 })).toMatchObject({
			status: 'R',
			oldPath: 'a',
			path: 'b',
		});
		expect(diffFileTitle({ status: 'M', path: 'b.ts', binary: true })).toMatchObject({ binary: true });
		expect(diffFileTitle({ status: 'M', path: 'c', truncated: true }).truncated).toBe(true);
		expect(diffFileTitle(null)).toMatchObject({ status: '?', path: '', add: 0, del: 0 });
	});
});

describe('[TC-PDCORE-071] a commit with no detail says whether it is still collecting', () => {
	it('distinguishes "coming soon" from "never collected"', () => {
		// The old flat wording became a lie once the window was fully covered, and read
		// as "clicking does nothing".
		expect(pendingNote({ pending: 42 }, 'abcdef1234567890')).toEqual({
			kind: 'collecting',
			pending: 42,
			shortSha: 'abcdef123456',
		});
		expect(pendingNote({ pending: 0 }, 'abcdef1234567890')).toMatchObject({ kind: 'missing', pending: 0 });
		expect(pendingNote(null, null)).toEqual({ kind: 'missing', pending: 0, shortSha: '' });
		expect(pendingNote({ pending: 'x' }, 12345)).toMatchObject({ kind: 'missing', shortSha: '12345' });
	});
});

describe('[TC-PDCORE-066] edge geometry follows the row positions', () => {
	it('draws straight inside a lane and curves across lanes', () => {
		const g = layoutGraph([c('m', 'a', 'b'), c('a'), c('b')]);
		const straight = g.edges.find((e) => e.to === 'a')!;
		const curved = g.edges.find((e) => e.to === 'b')!;
		expect(edgePath(straight, g.rows)).toBe(
			`M${GEOM.pad} ${GEOM.row / 2} L${GEOM.pad} ${GEOM.row / 2 + GEOM.row}`,
		);
		expect(edgePath(curved, g.rows)).toContain('C');
		// The stub for a parent outside the window is shorter than a full row. Its start is
		// the ROW's own `y` — the path never recomputes a position the layout already fixed.
		const stub = layoutGraph([c('x', 'gone')]).edges[0]!;
		const only: GraphRow = { sha: 'x', kind: 'commit', lane: 0, color: '#000', row: 0, x: 0, y: GEOM.row / 2 };
		expect(edgePath(stub, [only])).toBe(
			`M${GEOM.pad} ${GEOM.row / 2} L${GEOM.pad} ${GEOM.row / 2 + GEOM.row * 0.7}`,
		);
	});
});

describe('[TC-PDCORE-088] the row height is the caller’s, not a constant', () => {
	// A touch device renders 40px rows (`--pdmux-row` under `@media (pointer: coarse)`).
	// The geometry used to hard-code 24, so the SVG came out `24n` tall over a `40n` list
	// and every row past ~60% of the way down had no lane and no dot at all.
	const linear = [c('c1', 'c2'), c('c2', 'c3'), c('c3', 'c4')];

	it('steps and centres at the height it was given', () => {
		const g = layoutGraph(linear, { rowHeight: 40 });
		expect(g.rows.map((r) => r.y)).toEqual([20, 60, 100]);
		expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		// x is untouched: the lane gutter is not a function of row height.
		expect(g.rows.every((r) => r.x === GEOM.pad)).toBe(true);
	});

	it('sizes the box to the row stack it overlays', () => {
		expect(graphSize(layoutGraph(linear, { rowHeight: 40 }), 40).height).toBe(120);
		// The regression itself: sizing a 40px list with the default is short by a third.
		expect(graphSize(layoutGraph(linear, { rowHeight: 40 })).height).toBe(3 * GEOM.row);
	});

	it('scales the edge geometry with it', () => {
		const g = layoutGraph(linear, { rowHeight: 40 });
		expect(edgePath(g.edges[0]!, g.rows, 40)).toBe(`M${GEOM.pad} 20 L${GEOM.pad} 60`);
		const stub = layoutGraph([c('x', 'gone')], { rowHeight: 40 });
		expect(edgePath(stub.edges[0]!, stub.rows, 40)).toBe(`M${GEOM.pad} 20 L${GEOM.pad} ${20 + 40 * 0.7}`);
	});

	it('falls back to the default for a missing or nonsensical height', () => {
		for (const bad of [undefined, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(layoutGraph(linear, { rowHeight: bad }).rows[0]!.y).toBe(GEOM.row / 2);
		}
	});
});
