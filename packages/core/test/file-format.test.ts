import { describe, expect, it } from 'vitest';
import { UNKNOWN_VALUE, humanSize, modeLabel } from '../src/file-format.js';

describe('[TC-PDCORE-101] a listing prints what the host reported, and admits what it did not', () => {
	describe('sizes', () => {
		it('scales the unit and keeps one decimal only while it is worth having', () => {
			expect(humanSize(0)).toBe('0 B');
			expect(humanSize(999)).toBe('999 B');
			expect(humanSize(1024)).toBe('1.0 KB');
			expect(humanSize(1536)).toBe('1.5 KB');
			// Past 10 the decimal is noise in a right-aligned column.
			expect(humanSize(20 * 1024)).toBe('20 KB');
			expect(humanSize(1024 * 1024)).toBe('1.0 MB');
			expect(humanSize(1024 ** 3)).toBe('1.0 GB');
			expect(humanSize(1024 ** 4)).toBe('1.0 TB');
			// ⚠ IT CLIMBS PAST TB RATHER THAN STOPPING. The copy in `RepoTreeView`
			// stopped at MB, so the same file read `1.0 GB` in one panel and
			// `1024.0 MB` in the other.
			expect(humanSize(1024 ** 5)).toBe('1024 TB');
		});

		it('refuses a number that is not a size', () => {
			expect(humanSize(Number.NaN)).toBe(UNKNOWN_VALUE);
			expect(humanSize(-1)).toBe(UNKNOWN_VALUE);
		});
	});

	describe('modes', () => {
		it('writes the nine bits the way `ls` does', () => {
			expect(modeLabel(0o644)).toBe('rw-r--r--');
			expect(modeLabel(0o755)).toBe('rwxr-xr-x');
			expect(modeLabel(0o600)).toBe('rw-------');
			expect(modeLabel(0o777)).toBe('rwxrwxrwx');
			expect(modeLabel(0o400)).toBe('r--------');
		});

		it('has no type prefix — the row already says what the entry is', () => {
			expect(modeLabel(0o755)).toHaveLength(9);
		});

		it('ignores anything above the low nine bits', () => {
			// The agent sends `Perm()` only, so a caller handing over setuid bits is
			// confused rather than informative — the nine bits are still the answer.
			expect(modeLabel(0o4755)).toBe('rwxr-xr-x');
		});

		it('says it does not know instead of drawing a mode nobody measured', () => {
			// ⚠ `0` MEANS "THE HOST DID NOT SAY" — an agent older than the field, or a
			// stat that failed. Rendering `---------` would claim a file nobody may read.
			expect(modeLabel(0)).toBe(UNKNOWN_VALUE);
			expect(modeLabel(Number.NaN)).toBe(UNKNOWN_VALUE);
			expect(modeLabel(1.5)).toBe(UNKNOWN_VALUE);
		});
	});
});
