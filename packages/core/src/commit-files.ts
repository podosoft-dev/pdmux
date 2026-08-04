/**
 * Two judgements about a commit's changed files, kept out of the components that
 * draw them.
 *
 * Both are pure and both have a rule that is easy to get subtly wrong in markup —
 * which is the whole reason `@pdmux/core` exists (ARCHITECTURE §5).
 */

/** The shape both helpers read. It is `DiffFile` from the contract, narrowed. */
export interface ChangedFile {
	path: string;
	status: 'A' | 'M' | 'D' | 'R';
	add: number;
	del: number;
}

/** A directory in the tree. `path` is the full prefix, `label` what is drawn. */
export interface FileTreeDir {
	kind: 'dir';
	/** Full path from the root, so two directories with the same name differ. */
	path: string;
	/** What to draw — several segments when a chain was collapsed. */
	label: string;
	children: FileTreeNode[];
}

export interface FileTreeFile {
	kind: 'file';
	path: string;
	label: string;
	file: ChangedFile;
}

export type FileTreeNode = FileTreeDir | FileTreeFile;

/**
 * Group changed files by directory.
 *
 * ⚠ A CHAIN OF SINGLE-CHILD DIRECTORIES IS COLLAPSED INTO ONE ROW. A commit that
 * touches `apps/api/src/mcp/fleet-gateway.ts` and nothing else beside it would
 * otherwise cost four rows to say one thing, and a real commit touches several
 * such paths — the tree becomes taller than the file list it was meant to
 * summarise, which is the opposite of the point. Collapsed rows read
 * `apps/api/src/mcp/`, the way every file browser writes them.
 *
 * Files sort before directories at each level, then by name, so the things a
 * person is looking for are not pushed below an expanding hierarchy.
 */
export function fileTree(files: readonly ChangedFile[]): FileTreeNode[] {
	const root: FileTreeDir = { kind: 'dir', path: '', label: '', children: [] };

	for (const file of files) {
		const segments = file.path.split('/').filter((segment) => segment.length > 0);
		if (segments.length === 0) continue;
		const name = segments[segments.length - 1] as string;
		let cursor = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i] as string;
			const path = cursor.path ? `${cursor.path}/${segment}` : segment;
			let next = cursor.children.find(
				(child): child is FileTreeDir => child.kind === 'dir' && child.path === path,
			);
			if (!next) {
				next = { kind: 'dir', path, label: segment, children: [] };
				cursor.children.push(next);
			}
			cursor = next;
		}
		cursor.children.push({ kind: 'file', path: file.path, label: name, file });
	}

	// ⚠ THE ROOT IS A CONTAINER, NOT A ROW, so it is never folded. Folding it
	// hoists its only child's children into the top level and the outermost
	// directory disappears — `apps/api/src/mcp/` became a bare file row.
	for (const child of root.children) {
		if (child.kind === 'dir') collapse(child);
	}
	sort(root);
	return root.children;
}

/** Fold `a/` → `b/` → `c/` into one `a/b/c/` row, depth first. */
function collapse(dir: FileTreeDir): void {
	for (const child of dir.children) {
		if (child.kind === 'dir') collapse(child);
	}
	// Only a directory whose single child is itself a directory can fold: folding a
	// directory that holds one FILE would hide the directory the file lives in.
	while (dir.children.length === 1 && dir.children[0]?.kind === 'dir') {
		const only = dir.children[0] as FileTreeDir;
		dir.label = dir.label ? `${dir.label}/${only.label}` : only.label;
		dir.path = only.path;
		dir.children = only.children;
	}
}

/**
 * The same files as a flat list, in the order git itself names them.
 *
 * ⚠ THIS IS THE OTHER HALF OF A TOGGLE, NOT A LESSER TREE. A tree answers "which
 * areas did this commit touch"; a list answers "how many files, and where is the
 * one I am looking for" — and on a commit that touches twenty files across four
 * directories the tree costs a fold-out before it can answer the second question
 * at all. Fork puts both behind one button on the file list for exactly this
 * reason, so the sort has to be stable and predictable: full path, case-folded, so
 * `Foo.ts` and `foo.ts` do not swap places between two runs of the same commit.
 */
export function fileList(files: readonly ChangedFile[]): ChangedFile[] {
	return [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

function sort(dir: FileTreeDir): void {
	dir.children.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
	for (const child of dir.children) {
		if (child.kind === 'dir') sort(child);
	}
}

// ---------------------------------------------------------------------------
// The remote, compared
// ---------------------------------------------------------------------------

export interface LocalRef {
	/** Short name as the graph holds it — `main`, `origin/main`, `v1.0`. */
	name: string;
	sha: string;
	kind: 'local' | 'remote' | 'tag';
}

export interface RemoteRef {
	name: string;
	sha: string;
	kind: 'branch' | 'tag';
}

/**
 * What the remote has that we do not, said only as far as it can honestly be said.
 *
 *  - `same`      — the tracking ref already points where the remote does
 *  - `moved`     — the remote moved and we cannot say by how much
 *  - `appeared`  — a branch nothing local tracks
 *  - `gone`      — we track it and the remote no longer advertises it
 */
export type RemoteStatus = 'same' | 'moved' | 'appeared' | 'gone';

export interface RemoteComparisonRow {
	name: string;
	status: RemoteStatus;
	/**
	 * How far behind, when that is knowable — and `null` whenever it is not.
	 *
	 * ⚠ `ls-remote` DOWNLOADS NO OBJECTS, so a sha it reports is usually a commit
	 * this checkout has never seen and cannot count towards. A number here would be
	 * invented, and "3 commits behind" is the kind of confident wrong answer this
	 * codebase keeps a comment about everywhere it was tempted.
	 */
	behind: number | null;
}

/**
 * Compare what the remote advertises now against the remote-tracking refs the
 * last fetch left behind.
 *
 * `distance` is injected rather than computed: only the caller knows whether the
 * object is present locally, and the honest default is "unknown".
 */
export function remoteComparison(
	local: readonly LocalRef[],
	remote: readonly RemoteRef[],
	distance?: (localSha: string, remoteSha: string) => number | null,
): RemoteComparisonRow[] {
	const tracking = new Map<string, string>();
	for (const ref of local) {
		// `origin/main` tracks the remote's `main`. Anything without a slash is a
		// local branch and tracks nothing by name.
		if (ref.kind !== 'remote') continue;
		const slash = ref.name.indexOf('/');
		if (slash <= 0) continue;
		tracking.set(ref.name.slice(slash + 1), ref.sha);
	}

	const rows: RemoteComparisonRow[] = [];
	const seen = new Set<string>();
	for (const ref of remote) {
		if (ref.kind !== 'branch') continue;
		seen.add(ref.name);
		const known = tracking.get(ref.name);
		if (known === undefined) {
			rows.push({ name: ref.name, status: 'appeared', behind: null });
			continue;
		}
		if (known === ref.sha) {
			rows.push({ name: ref.name, status: 'same', behind: null });
			continue;
		}
		rows.push({ name: ref.name, status: 'moved', behind: distance?.(known, ref.sha) ?? null });
	}

	for (const [name] of tracking) {
		if (!seen.has(name)) rows.push({ name, status: 'gone', behind: null });
	}

	// Things that need attention first; `same` is the answer nobody reads twice.
	const rank: Record<RemoteStatus, number> = { moved: 0, appeared: 1, gone: 2, same: 3 };
	return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
