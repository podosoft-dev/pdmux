/**
 * How wide the number columns of a directory listing are, and which of them fit.
 *
 * ⚠ WIDTHS ARE NOT PERSISTED, ON PURPOSE, AND THAT IS WHY THEY ARE NOT IN
 * `TerminalLayout`. That document is stored per USER and shared across their
 * devices — `shell-state.svelte.ts` records what that costs: a phone's value
 * travelling to a desktop that has no room for it. A column width is a within-visit
 * adjustment to a panel whose own width changes, so it lives in the panel's store
 * and dies with the tab. The reducer is still here, because a clamp is judgement and
 * judgement is testable without a browser (ARCHITECTURE §5).
 *
 * ⚠ AND THE CLAMP IS AGAINST THE PANEL, NOT JUST AGAINST ITSELF. The dock this
 * panel lives in narrows to `DOCK_WIDTH_MIN` (260px) and narrows further on a small
 * viewport, so a width chosen in a wide window must not be able to squeeze the NAME
 * column — the one column somebody actually reads — down to nothing. That exact
 * failure is on record in `ui-changes.md`: a sibling panel added to a horizontal
 * flex row took the commit list from 420px to 0px, and every spec stayed green
 * because nothing measured geometry.
 */

export type FsColumnKey = 'size' | 'modified' | 'mode';

export type FsColumns = Record<FsColumnKey, number>;

/**
 * Right-to-left, which is also the order they are dropped in when the panel is
 * narrow: `mode` first, then `modified`. `size` always stays — of the three it is
 * the one people scan a directory for.
 */
export const FS_COLUMN_ORDER: readonly FsColumnKey[] = ['size', 'modified', 'mode'];

/**
 * Enough for the widest ordinary value in each, in the row's 11px monospace:
 * `999.9 KB`, an ISO `YYYY-MM-DD HH:MM`, and nine permission characters.
 */
export const FS_COLUMN_DEFAULTS: Readonly<FsColumns> = { size: 64, modified: 116, mode: 82 };

/** Below this a column cannot show its own header label, so it is not a column. */
export const FS_COLUMN_MIN: Readonly<FsColumns> = { size: 48, modified: 64, mode: 56 };

export const FS_COLUMN_MAX = 240;

/**
 * What the name column must keep.
 *
 * ⚠ NOT A GUESS AT A NICE WIDTH — the floor below which a listing stops being one.
 * At 96px the row still shows roughly a dozen monospace characters plus the ellipsis,
 * which is enough to tell two files apart; below it every row reads `compo…`.
 */
export const FS_NAME_MIN = 96;

/** The flex gap between cells. The stylesheet reads it from a custom property. */
export const FS_ROW_GAP = 8;

/**
 * Everything in a row that is neither a gap nor a column: the horizontal padding
 * and the icon.
 *
 * ⚠ IT MUST EQUAL WHAT `.pdmux-files-row` AND `.pdmux-files-icon` ACTUALLY SPEND
 * (`padding: 3px 6px` → 12, icon 14). CSS cannot read a TypeScript constant, so a
 * spec in `@pdmux/ui` reads the stylesheet and asserts the two agree — the
 * alternative is two numbers that drift and a name column that quietly loses its
 * floor.
 */
export const FS_ROW_CHROME = 26;

const clamp = (px: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(px)));

/** Room left for the name once `keys` are drawn at these widths. */
function nameRoom(panelWidth: number, columns: FsColumns, keys: readonly FsColumnKey[]): number {
	const used = keys.reduce((total, key) => total + columns[key] + FS_ROW_GAP, FS_ROW_CHROME + FS_ROW_GAP);
	return panelWidth - used;
}

export function defaultFsColumns(): FsColumns {
	return { ...FS_COLUMN_DEFAULTS };
}

/**
 * Which columns a panel this wide can carry.
 *
 * ⚠ DERIVED FROM THE CURRENT WIDTHS, NOT FROM BREAKPOINTS. A media query is the
 * wrong tool twice over: the same viewport holds a 420px dock and a full-width
 * window at once (`FileList` already learned this and measures with a
 * `ResizeObserver`), and a person who has widened `modified` by hand has changed
 * where the panel runs out — a fixed threshold would then be wrong by exactly what
 * they dragged.
 *
 * `panelWidth <= 0` means nothing has been measured yet; everything shows, because
 * the default dock is wide enough for all three and an observer corrects it before
 * a person can read the row.
 */
export function visibleFsColumns(panelWidth: number, columns: FsColumns = FS_COLUMN_DEFAULTS): readonly FsColumnKey[] {
	if (!Number.isFinite(panelWidth) || panelWidth <= 0) return FS_COLUMN_ORDER;
	let keys = [...FS_COLUMN_ORDER];
	while (keys.length > 1 && nameRoom(panelWidth, columns, keys) < FS_NAME_MIN) keys = keys.slice(0, -1);
	return keys;
}

/**
 * A dragged column edge.
 *
 * ⚠ `px` IS AN ABSOLUTE WIDTH, NOT A DELTA. `SplitHandle` reports a delta from
 * where the gesture STARTED, so the caller adds it to the width the gesture started
 * from — adding it to the current width compounds every pointer move into a runaway
 * column, which is the bug `+page.svelte` keeps a base latch for.
 *
 * A non-finite width (a drag that never moved, a corrupted value) leaves the
 * columns alone rather than writing `NaN`, exactly as `terminal-grid.ts`'s reducers
 * do.
 */
export function setFsColumnWidth(
	columns: FsColumns,
	key: FsColumnKey,
	px: number,
	panelWidth = 0,
): FsColumns {
	if (!Number.isFinite(px)) return columns;
	let next = clamp(px, FS_COLUMN_MIN[key], FS_COLUMN_MAX);
	if (Number.isFinite(panelWidth) && panelWidth > 0) {
		// ⚠ AGAINST THE COLUMNS ON SCREEN, NOT ALL THREE. A hidden column costs no
		// room, and reserving its width anyway made a narrow panel refuse a drag that
		// plainly had space for it — measured: at 326px, `modified` clamped to its
		// minimum because `mode`, which was not drawn, was still being paid for.
		const visible = visibleFsColumns(panelWidth, columns);
		if (!visible.includes(key)) return columns;
		const others = visible.filter((other) => other !== key);
		const room = nameRoom(panelWidth, columns, others) - FS_NAME_MIN - FS_ROW_GAP;
		next = Math.min(next, Math.max(FS_COLUMN_MIN[key], Math.round(room)));
	}
	return { ...columns, [key]: next };
}
