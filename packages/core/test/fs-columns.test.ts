import { describe, expect, it } from 'vitest';
import {
	FS_COLUMN_DEFAULTS,
	FS_COLUMN_MAX,
	FS_COLUMN_MIN,
	FS_NAME_MIN,
	FS_ROW_CHROME,
	FS_ROW_GAP,
	defaultFsColumns,
	setFsColumnWidth,
	visibleFsColumns,
} from '../src/fs-columns.js';

/** The panel width at which `keys` exactly fit beside a minimum name column. */
const widthFor = (keys: readonly ('size' | 'modified' | 'mode')[]): number =>
	FS_ROW_CHROME + FS_ROW_GAP + FS_NAME_MIN + keys.reduce((t, k) => t + FS_COLUMN_DEFAULTS[k] + FS_ROW_GAP, 0);

describe('[TC-PDCORE-103] a listing keeps its name column whatever the panel does', () => {
	describe('which columns fit', () => {
		it('drops from the right, and never drops the size', () => {
			expect(visibleFsColumns(widthFor(['size', 'modified', 'mode']))).toEqual([
				'size',
				'modified',
				'mode',
			]);
			expect(visibleFsColumns(widthFor(['size', 'modified']))).toEqual(['size', 'modified']);
			expect(visibleFsColumns(widthFor(['size']))).toEqual(['size']);
			// ⚠ EVEN ABSURDLY NARROW KEEPS ONE. A row with no number at all is a
			// different feature, not a narrow version of this one.
			expect(visibleFsColumns(1)).toEqual(['size']);
		});

		it('answers from the CURRENT widths, not from a breakpoint', () => {
			// Somebody who widened `modified` by hand has moved where the panel runs
			// out. A fixed threshold would be wrong by exactly what they dragged.
			const wide = { ...FS_COLUMN_DEFAULTS, modified: 240 };
			const panel = widthFor(['size', 'modified', 'mode']);
			expect(visibleFsColumns(panel, FS_COLUMN_DEFAULTS)).toContain('mode');
			expect(visibleFsColumns(panel, wide)).not.toContain('mode');
		});

		it('shows everything before anything has been measured', () => {
			// First paint and SSR: the default dock is wide enough, and the observer
			// corrects it before a person can read the row.
			expect(visibleFsColumns(0)).toEqual(['size', 'modified', 'mode']);
			expect(visibleFsColumns(Number.NaN)).toEqual(['size', 'modified', 'mode']);
		});
	});

	describe('a dragged edge', () => {
		it('clamps to the column’s own bounds and rounds', () => {
			const columns = defaultFsColumns();
			expect(setFsColumnWidth(columns, 'size', 120).size).toBe(120);
			expect(setFsColumnWidth(columns, 'size', 10).size).toBe(FS_COLUMN_MIN.size);
			expect(setFsColumnWidth(columns, 'size', 9999).size).toBe(FS_COLUMN_MAX);
			expect(setFsColumnWidth(columns, 'size', 87.6).size).toBe(88);
		});

		it('leaves the columns alone when the number is not one', () => {
			// A drag that never moved, or a value that came back corrupted: the reducers
			// in `terminal-grid.ts` refuse the same way rather than storing NaN.
			const columns = defaultFsColumns();
			expect(setFsColumnWidth(columns, 'size', Number.NaN)).toBe(columns);
			expect(setFsColumnWidth(columns, 'mode', Number.POSITIVE_INFINITY)).toBe(columns);
		});

		it('never lets a column eat the name', () => {
			// ⚠ THIS IS THE 420px → 0px INCIDENT, AS AN ASSERTION. Dragging a column as
			// wide as it will go, in a panel with barely room for it, must still leave
			// the name its floor.
			for (const panel of [widthFor(['size', 'modified']), widthFor(['size', 'modified', 'mode']), 420]) {
				const columns = defaultFsColumns();
				for (const key of visibleFsColumns(panel, columns)) {
					const dragged = setFsColumnWidth(columns, key, FS_COLUMN_MAX, panel);
					const visible = visibleFsColumns(panel, columns);
					const used = visible.reduce(
						(total, k) => total + dragged[k] + FS_ROW_GAP,
						FS_ROW_CHROME + FS_ROW_GAP,
					);
					expect(panel - used, `${panel}px, dragged ${key}`).toBeGreaterThanOrEqual(FS_NAME_MIN);
				}
			}
		});

		it('ignores a drag on a column the panel is not drawing', () => {
			// At a dock's minimum only `size` is on screen. A stale pointer event for a
			// column nobody can see must not resize it behind the scenes.
			const columns = defaultFsColumns();
			expect(visibleFsColumns(260, columns)).toEqual(['size']);
			expect(setFsColumnWidth(columns, 'mode', 200, 260)).toBe(columns);
		});

		it('still honours the minimum when there is no room at all', () => {
			// A panel too narrow to satisfy both the name floor and the column's own
			// minimum cannot be satisfied. The minimum wins and the stylesheet clips,
			// rather than producing a 3px column with a header nobody can read.
			const dragged = setFsColumnWidth(defaultFsColumns(), 'size', 200, 80);
			expect(dragged.size).toBe(FS_COLUMN_MIN.size);
		});

		it('returns a new object', () => {
			const columns = defaultFsColumns();
			const next = setFsColumnWidth(columns, 'size', 100);
			expect(next).not.toBe(columns);
			expect(columns.size).toBe(FS_COLUMN_DEFAULTS.size);
		});
	});
});
