/**
 * The order a directory listing is shown in, once a person has clicked a column.
 *
 * ⚠ THE AGENT ALREADY SORTED, AND THIS DOES NOT REPLACE THAT. `agent/internal/fs`
 * returns directories first and then by name, and it applies the entry cap
 * AFTERWARDS — so what arrives is "the first N in name order", not a sample.
 * Re-sorting here therefore reorders a list that was already chosen, which is why
 * the screen has to say so when `dropped > 0`: the largest file on the host may
 * simply not be in the array. Asking the agent to sort instead would fix that and
 * break something worse — every header click would be a round trip, and it would
 * change WHICH entries came back.
 *
 * ⚠ AND IT IS NOT `commit-files.ts`'s SORT. That one puts files before
 * directories, because a commit's changed files are read as a list of edits. A
 * live directory is browsed, and browsing means folders first. Reusing either for
 * the other would be a subtle, silent wrong answer.
 *
 * Pure and here rather than in a component for the usual reason (ARCHITECTURE §5):
 * a sort written in markup is a sort nobody can unit-test, and this one has three
 * rules that are each easy to get quietly wrong.
 */

export type FsSortKey = 'name' | 'size' | 'modified' | 'mode';

/**
 * ⚠ THE SHAPE AND THE TOGGLE RULE MIRROR `apps/web`'s `DataTable` ON PURPOSE.
 * That component owns every table in the admin console, and two tables in one
 * product that disagree about what a second click does is a bug people report as
 * confusion rather than as a defect. It cannot be imported — `[TC-PDUI-030]`
 * forbids this package from reaching into the app, and its `cmp()` lives inside an
 * instance `<script>` where nothing can import it anyway — so the vocabulary is
 * copied and this comment is the record that it was copied.
 */
export interface FsSort {
	key: FsSortKey;
	dir: 'asc' | 'desc';
}

/**
 * What the host sends, and therefore what no click has changed yet.
 *
 * Stored as the default rather than as `null` because the header has to render an
 * arrow somewhere from the first paint, and "name, ascending" is what the listing
 * already is.
 */
export const DEFAULT_FS_SORT: FsSort = { key: 'name', dir: 'asc' };

export function isDefaultFsSort(sort: FsSort): boolean {
	return sort.key === DEFAULT_FS_SORT.key && sort.dir === DEFAULT_FS_SORT.dir;
}

/** A click on a header: the same column flips, a new column starts ascending. */
export function nextFsSort(current: FsSort, key: FsSortKey): FsSort {
	if (current.key !== key) return { key, dir: 'asc' };
	return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/** The fields a sort reads. Structural, so the view type stays in `@pdmux/ui`. */
export interface FsSortable {
	name: string;
	dir: boolean;
	size: number;
	modified: number;
	mode: number;
}

/**
 * ⚠ `numeric: true` IS THE WHOLE POINT OF NOT USING `<`. Without it `a10.ts` sorts
 * before `a2.ts`, which in a directory of numbered files reads as no sort at all.
 * `sensitivity: 'base'` is what stops `Makefile` and `main.go` from being separated
 * by case, the same choice `commit-files.ts` made for changed paths.
 */
const byName = (a: FsSortable, b: FsSortable): number =>
	a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function compare(a: FsSortable, b: FsSortable, sort: FsSort): number {
	// ⚠ DIRECTORIES FIRST IN EVERY SORT, IN BOTH DIRECTIONS. The agent's comment
	// calls this "the order every file manager has taught people to expect", and it
	// is: a descending click that scattered folders through the files would read as
	// the sort being broken rather than as a different sort.
	if (a.dir !== b.dir) return a.dir ? -1 : 1;

	const flip = sort.dir === 'desc' ? -1 : 1;
	if (sort.key === 'name') return flip * byName(a, b);

	if (sort.key === 'size') {
		// A directory's size is not a fact about the directory — the agent sends the
		// entry's own size and the explorer renders nothing for it. Ordering folders
		// by it would shuffle them at random, so they keep their names' order.
		if (a.dir) return byName(a, b);
		return flip * (a.size - b.size) || byName(a, b);
	}

	// `modified` and `mode`: 0 means the host did not say. Unknown sorts LAST in
	// both directions — a descending click is a request to see the extremes, and a
	// column of em dashes at the top answers a question nobody asked.
	const left = sort.key === 'modified' ? a.modified : a.mode;
	const right = sort.key === 'modified' ? b.modified : b.mode;
	if (!left !== !right) return left ? -1 : 1;
	return flip * (left - right) || byName(a, b);
}

/**
 * A NEW array, always.
 *
 * ⚠ Sorting in place would reorder the caller's own listing — `terminal-grid.ts`
 * records the same trap for the host list, where an in-place sort rearranged the
 * sidebar as a side effect of drawing something else.
 */
export function sortFsEntries<T extends FsSortable>(entries: readonly T[], sort: FsSort): T[] {
	return [...entries].sort((a, b) => compare(a, b, sort));
}
