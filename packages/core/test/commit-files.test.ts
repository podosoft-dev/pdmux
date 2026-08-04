import { describe, expect, it } from 'vitest';
import {
	type ChangedFile,
	type FileTreeDir,
	fileTree,
	remoteComparison,
} from '../src/commit-files.js';

const file = (path: string, status: ChangedFile['status'] = 'M'): ChangedFile => ({
	path,
	status,
	add: 1,
	del: 0,
});

describe('[TC-PDGIT-014] a commit’s files, grouped', () => {
	it('[TC-PDGIT-014] collapses a chain of single-child directories into one row', () => {
		// ⚠ THE ASSERTION THIS FILE EXISTS FOR. Without folding, this one file costs
		// four rows — apps/ → api/ → src/ → mcp/ — and a real commit touches several
		// such paths, so the "summary" ends up taller than the flat list it replaced.
		const tree = fileTree([file('apps/api/src/mcp/fleet-gateway.ts')]);
		expect(tree).toHaveLength(1);
		const dir = tree[0] as FileTreeDir;
		expect(dir.kind).toBe('dir');
		expect(dir.label).toBe('apps/api/src/mcp');
		expect(dir.children.map((c) => c.label)).toEqual(['fleet-gateway.ts']);
	});

	it('[TC-PDGIT-014] stops folding where the tree actually branches', () => {
		const tree = fileTree([
			file('apps/api/src/mcp/gateway.ts'),
			file('apps/web/src/routes/page.svelte'),
		]);
		const root = tree[0] as FileTreeDir;
		expect(root.label).toBe('apps');
		expect(root.children.map((c) => c.label).sort()).toEqual(['api/src/mcp', 'web/src/routes']);
	});

	it('[TC-PDGIT-014] never folds a directory away from the file inside it', () => {
		// Folding on a single FILE child would print `apps/api/gateway.ts` as a
		// directory row and lose the directory the file lives in.
		const tree = fileTree([file('apps/gateway.ts')]);
		const dir = tree[0] as FileTreeDir;
		expect(dir.kind).toBe('dir');
		expect(dir.label).toBe('apps');
		expect(dir.children[0]?.kind).toBe('file');
	});

	it('[TC-PDGIT-014] puts files above directories so they are not pushed off', () => {
		const tree = fileTree([file('src/deep/one.ts'), file('src/a.ts'), file('src/b.ts')]);
		const dir = tree[0] as FileTreeDir;
		expect(dir.children.map((c) => `${c.kind}:${c.label}`)).toEqual([
			'file:a.ts',
			'file:b.ts',
			'dir:deep',
		]);
	});

	it('[TC-PDGIT-014] keeps two directories with the same name apart', () => {
		const tree = fileTree([file('a/src/x.ts'), file('b/src/y.ts')]);
		expect(tree).toHaveLength(2);
		const paths = (tree as FileTreeDir[]).map((d) => d.path).sort();
		expect(paths).toEqual(['a/src', 'b/src']);
	});
});

describe('[TC-PDGIT-014] the remote, compared', () => {
	const localRef = (name: string, sha: string) => ({ name, sha, kind: 'remote' as const });
	const remoteRef = (name: string, sha: string) => ({ name, sha, kind: 'branch' as const });

	it('[TC-PDGIT-014] says a branch moved without saying by how much', () => {
		// ⚠ THE NUMBER IS THE LIE THIS GUARDS. `ls-remote` downloads no objects, so
		// the remote sha is usually a commit this checkout has never seen — nothing
		// can count the distance to it, and "3 commits behind" would be invented.
		const rows = remoteComparison([localRef('origin/main', 'aaa')], [remoteRef('main', 'bbb')]);
		expect(rows).toEqual([{ name: 'main', status: 'moved', behind: null }]);
	});

	it('[TC-PDGIT-014] reports a distance only when the caller could measure one', () => {
		const rows = remoteComparison(
			[localRef('origin/main', 'aaa')],
			[remoteRef('main', 'bbb')],
			(from, to) => (from === 'aaa' && to === 'bbb' ? 3 : null),
		);
		expect(rows[0]).toEqual({ name: 'main', status: 'moved', behind: 3 });
	});

	it('[TC-PDGIT-014] tells apart same, appeared and gone', () => {
		const rows = remoteComparison(
			[localRef('origin/main', 'aaa'), localRef('origin/old', 'ccc')],
			[remoteRef('main', 'aaa'), remoteRef('dev', 'ddd')],
		);
		expect(rows).toEqual([
			{ name: 'dev', status: 'appeared', behind: null },
			{ name: 'old', status: 'gone', behind: null },
			{ name: 'main', status: 'same', behind: null },
		]);
	});

	it('[TC-PDGIT-014] ignores tags and local branches when matching', () => {
		const rows = remoteComparison(
			[
				{ name: 'main', sha: 'aaa', kind: 'local' },
				{ name: 'v1.0', sha: 'ttt', kind: 'tag' },
			],
			[remoteRef('main', 'bbb'), { name: 'v1.0', sha: 'ttt', kind: 'tag' }],
		);
		// The local `main` is not a tracking ref, so the remote's `main` is new to us;
		// the tag is not a branch and has no row at all.
		expect(rows).toEqual([{ name: 'main', status: 'appeared', behind: null }]);
	});
});
