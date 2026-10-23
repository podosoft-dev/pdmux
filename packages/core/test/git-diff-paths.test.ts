import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeDiffFilePaths } from '../src/git-diff-paths.js';

const cases = JSON.parse(readFileSync(new URL('../../../agent/internal/git/testdata/diff-paths.json', import.meta.url), 'utf8')) as {
	name: string; path: string; oldPath: string; legacyPath: string; legacyOldPath: string | null; repair: boolean;
}[];

describe('[TC-PDGIT-056] legacy quoted diff paths', () => {
	for (const row of cases.filter(row => row.repair)) it(row.name, () => {
		const file = { path: row.legacyPath, oldPath: row.legacyOldPath, status: 'M' as const, add: 4, del: 1, lines: ['-old', '+new'] };
		const normalized = normalizeDiffFilePaths(file);
		expect(normalized).toEqual({ ...file, path: row.path, oldPath: row.oldPath === row.path ? null : row.oldPath });
		expect(file.path).toBe(row.legacyPath);
		expect(normalizeDiffFilePaths(normalized)).toBe(normalized);
	});
	it('keeps decoded paths, literal escapes and malformed fragments unchanged', () => {
		for (const path of ['docs/베이스라인.md', 'docs/literal "b/x"', 'literal-\\353.md', 'docs/literal \"b/x\"', '"literal".md', '/broken" "b/unterminated', '/bad\\999" "b/bad\\999"', '/bad\\377" "b/bad\\377"']) {
			const file = { path, oldPath: null };
			expect(normalizeDiffFilePaths(file)).toBe(file);
		}
	});
});
