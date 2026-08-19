import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FS_SORT,
	type FsSort,
	type FsSortKey,
	type FsSortable,
	isDefaultFsSort,
	nextFsSort,
	sortFsEntries,
} from '../src/fs-sort.js';

const entry = (name: string, over: Partial<FsSortable> = {}): FsSortable => ({
	name,
	dir: false,
	size: 0,
	modified: 1_700_000_000,
	mode: 0o644,
	...over,
});

const names = (rows: readonly FsSortable[]): string[] => rows.map((row) => row.name);
const both: readonly FsSort['dir'][] = ['asc', 'desc'];
const keys: readonly FsSortKey[] = ['name', 'size', 'modified', 'mode'];

describe('[TC-PDCORE-102] a clicked column reorders a listing without losing its grouping', () => {
	describe('the toggle rule', () => {
		it('flips the same column and starts a new one ascending', () => {
			expect(nextFsSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
			expect(nextFsSort({ key: 'name', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
			// ⚠ A NEW COLUMN DOES NOT INHERIT THE OLD DIRECTION. Descending by name and
			// then clicking `size` would otherwise show the biggest files while the arrow
			// says ascending — the mismatch `DataTable` already avoids this way.
			expect(nextFsSort({ key: 'name', dir: 'desc' }, 'size')).toEqual({ key: 'size', dir: 'asc' });
		});

		it('knows when nothing has been clicked yet', () => {
			expect(isDefaultFsSort(DEFAULT_FS_SORT)).toBe(true);
			// The screen uses this to decide whether to warn that it sorted a list the
			// host had already truncated.
			expect(isDefaultFsSort({ key: 'name', dir: 'desc' })).toBe(false);
			expect(isDefaultFsSort({ key: 'size', dir: 'asc' })).toBe(false);
		});
	});

	describe('directories stay first', () => {
		it('groups them in every key and both directions', () => {
			const rows = [
				entry('zebra.txt', { size: 900, modified: 5, mode: 0o600 }),
				entry('alpha', { dir: true, size: 4096, modified: 1, mode: 0o755 }),
				entry('beta.txt', { size: 10, modified: 9, mode: 0o644 }),
				entry('omega', { dir: true, size: 4096, modified: 7, mode: 0o700 }),
			];
			for (const key of keys) {
				for (const dir of both) {
					const sorted = sortFsEntries(rows, { key, dir });
					expect(
						sorted.slice(0, 2).every((row) => row.dir),
						`${key}/${dir} → ${names(sorted).join(',')}`,
					).toBe(true);
				}
			}
		});

		it('keeps folders in name order under a size sort', () => {
			// A directory's `size` is the entry's own, not its contents', so ordering by
			// it would shuffle folders at random — and the explorer draws nothing there.
			const rows = [
				entry('omega', { dir: true, size: 4096 }),
				entry('alpha', { dir: true, size: 64 }),
				entry('file.txt', { size: 1 }),
			];
			expect(names(sortFsEntries(rows, { key: 'size', dir: 'desc' })).slice(0, 2)).toEqual([
				'alpha',
				'omega',
			]);
		});
	});

	describe('names', () => {
		it('counts numbers as numbers', () => {
			// ⚠ WITHOUT `numeric: true` THIS IS `a10, a2` — which in a directory of
			// numbered files reads as no sort at all.
			const rows = [entry('a10.ts'), entry('a2.ts'), entry('a1.ts')];
			expect(names(sortFsEntries(rows, { key: 'name', dir: 'asc' }))).toEqual([
				'a1.ts',
				'a2.ts',
				'a10.ts',
			]);
		});

		it('does not separate names by case', () => {
			const rows = [entry('main.go'), entry('Makefile'), entry('README.md')];
			expect(names(sortFsEntries(rows, { key: 'name', dir: 'asc' }))).toEqual([
				'main.go',
				'Makefile',
				'README.md',
			]);
		});
	});

	describe('numbers the host may not have reported', () => {
		it('puts an unknown value last in BOTH directions', () => {
			// A descending click asks to see the extremes. A column of em dashes at the
			// top answers a question nobody asked.
			const rows = [entry('known.txt', { modified: 100 }), entry('quiet.txt', { modified: 0 })];
			for (const dir of both) {
				expect(names(sortFsEntries(rows, { key: 'modified', dir }))[1]).toBe('quiet.txt');
			}
			const modes = [entry('known.txt', { mode: 0o644 }), entry('quiet.txt', { mode: 0 })];
			for (const dir of both) {
				expect(names(sortFsEntries(modes, { key: 'mode', dir }))[1]).toBe('quiet.txt');
			}
		});

		it('sorts an empty file as a real zero, because it is one', () => {
			const rows = [entry('big.txt', { size: 10 }), entry('empty.txt', { size: 0 })];
			expect(names(sortFsEntries(rows, { key: 'size', dir: 'asc' }))).toEqual([
				'empty.txt',
				'big.txt',
			]);
		});
	});

	describe('ties', () => {
		it('breaks them by name so the order never wobbles', () => {
			const rows = [entry('c.txt', { size: 5 }), entry('a.txt', { size: 5 }), entry('b.txt', { size: 5 })];
			expect(names(sortFsEntries(rows, { key: 'size', dir: 'desc' }))).toEqual([
				'a.txt',
				'b.txt',
				'c.txt',
			]);
		});
	});

	it('never reorders the array it was given', () => {
		// ⚠ An in-place sort here would rearrange the store's own listing as a side
		// effect of drawing it — the trap `terminal-grid.ts` records for the host list.
		const rows = [entry('b.txt'), entry('a.txt')];
		const before = names(rows);
		sortFsEntries(rows, { key: 'name', dir: 'asc' });
		expect(names(rows)).toEqual(before);
	});
});
