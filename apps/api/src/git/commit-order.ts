/**
 * Stable topological order for one commit window (newest first).
 *
 * WHY THIS EXISTS. `layoutGraph` (`packages/core/src/commit-graph.ts`) reads the feed
 * order as fact: a commit nothing is waiting for IS a branch tip. Hand it a parent
 * before its child and that parent opens a lane which never closes, so the rest of the
 * history slides one lane right and the rejoin is drawn as a line going back UP the
 * screen. The order has one authority — `RepoCommit.seq`, the position the agent walked
 * with `git log --date-order`.
 *
 * The hole is that `seq` is nullable. Rows no window currently places keep NULL (see
 * `GitIngestService.clearStaleWindowPositions`), and for those the read falls back to
 * `date DESC` — the AUTHOR date, at one-second resolution. Commits made inside the same
 * second then come back in an order the database never promised, and roughly half of
 * those orders put a parent above its child. Measured on this deployment: a 54-commit,
 * zero-merge history rendered as TWO lanes with 48 rows displaced, because `1a0aad8`
 * arrived before its child `1d5a67e` — both stamped `2026-07-27 05:36:05`.
 *
 * WHY IT CANNOT INVENT A STRAIGHT LINE. This is the objection recorded against putting a
 * guard inside `layoutGraph`, and it does not apply to a STABLE pass. The only ordering
 * constraints here are ancestor edges; the two tips of a genuine fork are unrelated, so
 * nothing orders them and their original positions survive exactly. The pass is a no-op
 * on any window that already satisfies the invariant — which is every `seq`-ordered one
 * — and moves a row only when the input claimed something that cannot be true.
 */

/** The shape this pass needs: everything else on a row is irrelevant to the order. */
export interface OrderableCommit {
  readonly sha: string;
  readonly parents: readonly string[];
}

/**
 * Reorders `commits` so no commit appears before one of its own descendants.
 *
 * Kahn's algorithm with the ORIGINAL position as the tie-break, which is what makes it
 * stable. Returns a new array; the input is not touched.
 */
export function stableTopoOrder<T extends OrderableCommit>(commits: readonly T[]): T[] {
  const total = commits.length;
  if (total < 2) return [...commits];

  // First occurrence wins. A repeated sha cannot happen — `(repoId, sha)` is unique —
  // but resolving it to one node keeps the counts below consistent if it ever does.
  const at = new Map<string, number>();
  for (let i = 0; i < total; i++) {
    const commit = commits[i];
    if (commit && !at.has(commit.sha)) at.set(commit.sha, i);
  }

  // `waiting[i]` = how many children of commit i are still unemitted. `parentsOf[i]` =
  // the parents of i that live in this window; a parent outside it constrains nothing,
  // which is the same fact the layout draws as an `open` edge.
  const waiting: number[] = new Array<number>(total).fill(0);
  const parentsOf: number[][] = [];
  for (let i = 0; i < total; i++) {
    const targets: number[] = [];
    const seen = new Set<number>();
    for (const parent of commits[i]?.parents ?? []) {
      const index = at.get(parent);
      if (index === undefined || index === i || seen.has(index)) continue;
      seen.add(index);
      targets.push(index);
      waiting[index] = (waiting[index] ?? 0) + 1;
    }
    parentsOf.push(targets);
  }

  // A binary heap keyed by the original position: among the rows free to be emitted,
  // always take the one the feed put first.
  const heap: number[] = [];
  const push = (value: number): void => {
    heap.push(value);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if ((heap[parent] ?? 0) <= (heap[child] ?? 0)) break;
      const swap = heap[parent] ?? 0;
      heap[parent] = heap[child] ?? 0;
      heap[child] = swap;
      child = parent;
    }
  };
  const pop = (): number | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        let smallest = parent;
        if (left < heap.length && (heap[left] ?? 0) < (heap[smallest] ?? 0)) smallest = left;
        if (left + 1 < heap.length && (heap[left + 1] ?? 0) < (heap[smallest] ?? 0)) smallest = left + 1;
        if (smallest === parent) break;
        const swap = heap[parent] ?? 0;
        heap[parent] = heap[smallest] ?? 0;
        heap[smallest] = swap;
        parent = smallest;
      }
    }
    return top;
  };

  for (let i = 0; i < total; i++) if ((waiting[i] ?? 0) === 0) push(i);

  const out: T[] = [];
  const emitted: boolean[] = new Array<boolean>(total).fill(false);
  for (;;) {
    const index = pop();
    if (index === undefined) break;
    const commit = commits[index];
    if (!commit) continue;
    out.push(commit);
    emitted[index] = true;
    for (const parent of parentsOf[index] ?? []) {
      const left = (waiting[parent] ?? 0) - 1;
      waiting[parent] = left;
      if (left === 0) push(parent);
    }
  }

  // A cycle is impossible in git, but DROPPING commits would be a far worse failure than
  // an odd-looking graph: anything the walk could not reach is appended as it arrived.
  if (out.length < total) {
    for (let i = 0; i < total; i++) {
      const commit = commits[i];
      if (commit && !emitted[i]) out.push(commit);
    }
  }
  return out;
}
