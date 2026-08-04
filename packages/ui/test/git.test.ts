/**
 * Read-only commit graph, detail panel and patch rendering.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingNote, uncommittedSummary } from '@pdmux/core';
import CommitDetail from '../src/components/CommitDetail.svelte';
import DiffView from '../src/components/DiffView.svelte';
import GitGraph from '../src/components/GitGraph.svelte';
import GitRefPanel from '../src/components/GitRefPanel.svelte';

afterEach(cleanup);

const COMMITS = [
	{ sha: 'm1'.padEnd(40, '0'), parents: ['a2'.padEnd(40, '0'), 'f1'.padEnd(40, '0')], subject: 'merge feature', author: 'tester', date: 1_784_000_000, refs: ['HEAD -> main', 'origin/main'] },
	{ sha: 'f1'.padEnd(40, '0'), parents: ['a1'.padEnd(40, '0')], subject: 'feature commit', author: 'tester', date: 1_783_900_000, refs: ['feat/x'] },
	{ sha: 'a2'.padEnd(40, '0'), parents: ['a1'.padEnd(40, '0')], subject: 'main commit', author: 'tester', date: 1_783_800_000, refs: [] },
	{ sha: 'a1'.padEnd(40, '0'), parents: [], subject: 'root', author: 'tester', date: 1_783_700_000, refs: ['tag: v1.0.0'] },
];

const REFS = [
	{ name: 'main', kind: 'local' as const, sha: 'm1' },
	{ name: 'origin/main', kind: 'remote' as const, sha: 'm1' },
];

describe('[TC-PDUI-020] the graph draws one clickable row per commit', () => {
	it('renders lanes, chips and reports the selected sha', () => {
		const onSelect = vi.fn();
		const { container } = render(GitGraph, {
			props: { commits: COMMITS, refs: REFS, head: COMMITS[0]!.sha, onSelect },
		});
		expect(container.querySelectorAll('.pdmux-graph-row')).toHaveLength(4);
		expect(container.querySelectorAll('circle.pdmux-dot')).toHaveLength(4);
		// The merge fans out, so more than one lane is drawn.
		expect(container.querySelectorAll('path.pdmux-edge').length).toBeGreaterThan(2);
		// A slash is not a remote marker: `feat/x` is local.
		const chips = [...container.querySelectorAll('.pdmux-graph-chip')].map((n) => [
			n.getAttribute('data-kind'),
			n.textContent,
		]);
		expect(chips).toContainEqual(['local', 'feat/x']);
		expect(chips).toContainEqual(['remote', 'origin/main']);
		expect(chips).toContainEqual(['head', 'main']);
		expect(chips).toContainEqual(['tag', 'v1.0.0']);

		(container.querySelector('.pdmux-graph-row') as HTMLElement).click();
		expect(onSelect).toHaveBeenCalledWith(COMMITS[0]!.sha);
	});

	it('pins the working tree above HEAD and says when there is nothing at all', () => {
		const summary = uncommittedSummary({ unstaged: 11, untracked: 2 })!;
		const { container } = render(GitGraph, {
			props: {
				commits: COMMITS,
				refs: REFS,
				head: COMMITS[0]!.sha,
				uncommitted: summary,
				uncommittedLabel: 'modified 11 · untracked 2',
			},
		});
		const first = container.querySelector('.pdmux-graph-row') as HTMLElement;
		expect(first.classList.contains('pdmux-wip')).toBe(true);
		expect(first.textContent).toContain('modified 11');
		expect(container.querySelector('[data-pdmux-sha="uncommitted"]')).not.toBeNull();

		const empty = render(GitGraph, { props: { commits: [] } });
		expect(empty.container.querySelector('[data-pdmux-empty="graph"]')).not.toBeNull();
	});

	it('is a scroll container, because a long list must not push the detail off screen', () => {
		const { container } = render(GitGraph, { props: { commits: COMMITS } });
		// jsdom cannot measure, so this asserts the contract the browser spec verifies
		// for real: the list owns its own scrolling.
		expect(container.querySelector('.pdmux-graph-list')).not.toBeNull();
	});
});

describe('[TC-PDUI-021] the detail panel explains a commit, including when it has none', () => {
	/**
	 * ⚠ THE PANEL OPENS ON THE CHANGES. It is what the click was for and what this
	 * panel showed before it had tabs, so a default of "Commit" would have made the
	 * common case cost an extra click. The message moved behind a tab, not away.
	 */
	it('[TC-PDUI-021] renders the header from the row and opens on the file list', async () => {
		const { container } = render(CommitDetail, {
			props: {
				commit: { sha: 'abc1234567', subject: 'fix: something', author: 'tester', date: 1_784_000_000 },
				detail: { body: 'why it was done', files: [{ path: 'a.ts', add: 1, del: 0, lines: ['@@ -1 +1 @@', '+x'] }] },
				formatDate: () => '2026-07-01 00:00',
			},
		});
		expect(container.querySelector('[data-pdmux-subject]')?.textContent).toBe('fix: something');
		expect(container.querySelector('[data-pdmux-meta]')?.textContent).toContain('2026-07-01');
		expect(container.querySelector('[data-pdmux-file-row="a.ts"]')).not.toBeNull();
		// The body is a tab away, not gone.
		expect(container.querySelector('[data-pdmux-body]')).toBeNull();
	});

	/**
	 * ⚠ THE POINT OF THE FILE LIST. It shipped drawing paths and nothing else — a
	 * list you could read and not open — and that is what was reported: "clicking a
	 * file shows a diff in Fork, and that is missing here". So the guard is the pair:
	 * no patch until a file is chosen, that file's patch once it is.
	 */
	it('[TC-PDUI-205] shows a file’s patch only once that file is chosen', () => {
		const props = {
			commit: { sha: 'abc1234567', subject: 'fix: something', author: 'tester', date: 1_784_000_000 },
			detail: {
				body: '',
				files: [
					{ path: 'a.ts', add: 1, del: 0, lines: ['@@ -1 +1 @@', '+first'] },
					{ path: 'b.ts', add: 2, del: 0, lines: ['@@ -1 +1 @@', '+second'] },
				],
			},
		};
		const idle = render(CommitDetail, { props });
		expect(idle.container.querySelector('[data-pdmux-file-row="a.ts"]')).not.toBeNull();
		expect(idle.container.querySelector('[data-pdmux-file="a.ts"]')).toBeNull();

		cleanup();
		const chosen = render(CommitDetail, { props: { ...props, selectedPath: 'a.ts' } });
		expect(chosen.container.querySelector('[data-pdmux-file="a.ts"]')).not.toBeNull();
		expect(chosen.container.querySelector('[data-pdmux-file-row="a.ts"]')?.getAttribute('aria-current')).toBe('true');
		// Only that one — a second patch would be the old "everything at once" screen.
		expect(chosen.container.querySelector('[data-pdmux-file="b.ts"]')).toBeNull();

		// Clicking the open row again closes it — Fork's toggle, and the same gesture
		// the commit rows in the graph already use.
		cleanup();
		const reclosed = render(CommitDetail, { props: { ...props, selectedPath: null } });
		expect(reclosed.container.querySelector('[data-pdmux-file-patch]')).toBeNull();
	});

	/**
	 * ⚠ THE HEADER IS A REGION, NOT THE FIRST TWO LINES OF THE BODY.
	 *
	 * What a commit IS does not change while you read what it DID, so identity is
	 * pinned above the scroller and the body scrolls under it. Before that they were
	 * loose siblings at one weight and read as a single wall of text — and the
	 * pinning only works while the header is a separate element, which is what this
	 * asserts. Where it SITS is geometry, so `[TC-PDUI-042]`'s neighbours measure it.
	 */
	it('[TC-PDUI-208] separates the commit’s identity from what it changed', () => {
		const { container } = render(CommitDetail, {
			props: {
				view: 'commit' as const,
				commit: {
					sha: 'abc1234567890',
					subject: 'fix: something',
					author: 'tester',
					date: 1_784_000_000,
					refs: ['main'],
				},
				detail: { body: 'why', authorEmail: 't@e.com', files: [{ path: 'a.ts', add: 1, del: 0, lines: [] }] },
				formatDate: () => '2026-07-01 00:00',
			},
		});
		const head = container.querySelector('[data-pdmux-detail-head]');
		expect(head, 'the header is not its own region').not.toBeNull();
		// Identity lives in the header…
		expect(head?.querySelector('[data-pdmux-subject]')?.textContent).toBe('fix: something');
		// …and nothing that scrolls does. A body element inside the header would be
		// pinned along with it, which is the failure this guards.
		expect(head?.querySelector('[data-pdmux-facts]')).toBeNull();
		expect(head?.querySelector('[data-pdmux-tree-file]')).toBeNull();

		// The body is sectioned: the facts and the files are two answers, not one.
		const body = container.querySelector('[data-pdmux-tabpanel="commit"]');
		expect(body?.querySelector('[data-pdmux-section="about"] [data-pdmux-facts]')).not.toBeNull();
		expect(body?.querySelector('[data-pdmux-section="files"] [data-pdmux-tree-file="a.ts"]')).not.toBeNull();
	});

	/**
	 * ⚠ THE THIRD FACE IS A DIFFERENT LIST. `changes` is what the commit touched;
	 * `tree` is every file that EXISTED at it, and opening one shows its CONTENTS
	 * rather than a patch. Conflating the two is the mistake this face was rebuilt
	 * to undo.
	 */
	it('[TC-PDUI-207] lists the repository at the commit and reads one file', () => {
		const props = {
			view: 'tree' as const,
			commit: { sha: 'abc1234567', subject: 's', author: 'tester', date: 1_784_000_000 },
			detail: { body: '', files: [] },
			treeEntries: [
				{ path: 'src/deep/a.ts', size: 12 },
				{ path: 'README.md', size: 2048 },
			],
		};
		const listing = render(CommitDetail, { props });
		expect(listing.container.querySelector('[data-pdmux-file-row="README.md"]')).not.toBeNull();
		// A file the COMMIT did not touch is still listed: this is the repository.
		expect(listing.container.querySelector('[data-pdmux-file-row="src/deep/a.ts"]')).not.toBeNull();
		// ⚠ A DIRECTORY IS A DISCLOSURE, NOT A SELECTION. Choosing a folder has
		// nothing to show, so it must not be given a row that looks selectable.
		expect(listing.container.querySelector('[data-pdmux-tree-dir="src/deep"]')).not.toBeNull();
		expect(listing.container.querySelector('[data-pdmux-file-row="src/deep"]')).toBeNull();
		expect(listing.container.querySelector('[data-pdmux-tree-toggle="src/deep"]')).not.toBeNull();

		cleanup();
		const open = render(CommitDetail, {
			props: {
				...props,
				treePath: 'README.md',
				blob: { path: 'README.md', lines: ['# pdmux', '', 'a dashboard'] },
			},
		});
		expect(open.container.querySelector('[data-pdmux-blob="README.md"]')?.textContent).toContain('a dashboard');
	});

	/**
	 * ⚠ THE FILE IS COLOURED, AND THE COLOURING IS THE ONLY MARKUP THAT REACHES THE
	 * PAGE. Everything here comes out of somebody's repository, so the guard is the
	 * pair: a keyword is a span (it highlighted) AND a `<script>` in the source is
	 * text (it was escaped on the way).
	 *
	 * ⚠ THE GRAMMAR COMES FROM THE PATH. `highlightAuto` guesses from content and
	 * guesses differently for two files in one project.
	 */
	it('[TC-PDUI-209] highlights a file by its extension and escapes what it draws', () => {
		const { container } = render(CommitDetail, {
			props: {
				view: 'tree' as const,
				commit: { sha: 'abc1234567', subject: 's', author: 'tester', date: 1_784_000_000 },
				detail: { body: '', files: [] },
				treeEntries: [{ path: 'src/a.ts', size: 12 }],
				treePath: 'src/a.ts',
				blob: {
					path: 'src/a.ts',
					lines: ['const x = 1;', '// <script>alert(1)</script>'],
				},
			},
		});
		const view = container.querySelector('[data-pdmux-blob="src/a.ts"]');
		expect(view?.getAttribute('data-pdmux-blob-lang')).toBe('typescript');
		// It actually highlighted: `const` is a keyword span, not bare text.
		expect(view?.querySelector('.hljs-keyword')?.textContent).toBe('const');
		// ⚠ AND THE `<script>` IN THE SOURCE IS TEXT. A real element here would mean
		// a repository could put markup on this page.
		expect(view?.querySelector('script')).toBeNull();
		expect(view?.textContent).toContain('<script>alert(1)</script>');
		// The numbers are their own column, so they are not inside the code.
		expect(container.querySelector('.pdmux-blob-gutter')?.textContent).toBe('1\n2');
	});

	it('[TC-PDUI-209] falls back to plain text for a file it has no grammar for', () => {
		const { container } = render(CommitDetail, {
			props: {
				view: 'tree' as const,
				commit: { sha: 'abc1234567', subject: 's', author: 'tester', date: 1_784_000_000 },
				detail: { body: '', files: [] },
				treeEntries: [{ path: 'LICENSE', size: 12 }],
				treePath: 'LICENSE',
				blob: { path: 'LICENSE', lines: ['Copyright <holder>'] },
			},
		});
		const view = container.querySelector('[data-pdmux-blob="LICENSE"]');
		expect(view?.getAttribute('data-pdmux-blob-lang')).toBe('text');
		// Still escaped: the fallback path is not a hole in the one above.
		expect(view?.textContent).toContain('Copyright <holder>');
	});

	/**
	 * ⚠ AN AGENT TOO OLD NEVER ANSWERS AT ALL — it logs the frame it does not know
	 * and keeps its socket — so the failure mode without this is a spinner that
	 * never stops. The screen has to say what is wrong instead.
	 */
	it('[TC-PDUI-207] says so when the host’s agent cannot list files', () => {
		const { container } = render(CommitDetail, {
			props: {
				view: 'tree' as const,
				commit: { sha: 'abc1234567', subject: 's', author: 'tester', date: 1_784_000_000 },
				detail: { body: '', files: [] },
				treeUnavailable: true,
			},
		});
		const note = container.querySelector('[data-pdmux-tree-state="unavailable"]');
		expect(note).not.toBeNull();
		expect(note?.textContent).toContain('agent');
	});

	it('[TC-PDUI-021] draws the face the app asked for', () => {
		const commitView = render(CommitDetail, {
			props: {
				view: 'commit' as const,
				commit: {
					sha: 'abc1234567',
					subject: 'fix: something',
					author: 'tester',
					date: 1_784_000_000,
					parents: ['0123456789abcdef'],
					refs: ['main'],
				},
				detail: {
					body: 'why it was done',
					authorEmail: 'tester@example.com',
					files: [{ path: 'src/deep/a.ts', add: 3, del: 1, lines: ['@@ -1 +1 @@', '+x'] }],
				},
				formatDate: () => '2026-07-01 00:00',
			},
		});

		const commit = commitView.container;
		expect(commit.querySelector('[data-pdmux-body]')?.textContent).toContain('why it was done');
		expect(commit.querySelector('[data-pdmux-facts]')?.textContent).toContain('tester@example.com');
		expect(commit.querySelector('[data-pdmux-parents]')?.textContent).toContain('0123456');
		expect(commit.querySelector('[data-pdmux-refs]')?.textContent).toContain('main');
		// ⚠ NO COMMITTER LINE: it equals the author here, and printing both would be
		// two lines saying one thing on almost every commit in existence.
		expect(commit.querySelector('[data-pdmux-committer]')).toBeNull();

		// ⚠ AND THE FILE LIST IS ON THIS FACE, not on a third tab. Fork's Commit tab has
		// shown the full list of changes since 1.0.70; splitting the facts from what the
		// commit touched made this face a dead end. The chain folded into one row — that
		// is `fileTree()`'s rule, seen through.
		expect(commit.querySelector('[data-pdmux-tree-dir="src/deep"]')).not.toBeNull();
		expect(commit.querySelector('[data-pdmux-tree-file="src/deep/a.ts"]')).not.toBeNull();
	});

	it('[TC-PDUI-021] draws the committer only when it differs from the author', () => {
		const { container } = render(CommitDetail, {
			props: {
				view: 'commit' as const,
				commit: { sha: 'abc1234567', subject: 's', author: 'tester', date: 1_784_000_000 },
				detail: {
					body: '',
					authorEmail: 'tester@example.com',
					committer: 'somebody else',
					committerEmail: 'else@example.com',
					committerDate: 1_784_000_500,
					files: [],
				},
				formatDate: () => '2026-07-01 00:00',
			},
		});
		// Its presence IS the signal — it means a rebase, a cherry-pick or a patch
		// applied on somebody's behalf.
		expect(container.querySelector('[data-pdmux-committer]')).not.toBeNull();
		expect(container.querySelector('[data-pdmux-facts]')?.textContent).toContain('somebody else');
	});

	it('distinguishes "still collecting" from "never collected"', () => {
		const collecting = render(CommitDetail, {
			props: { commit: { sha: 'abc1234567' }, pending: pendingNote({ pending: 42 }, 'abc1234567890') },
		});
		expect(collecting.container.querySelector('[data-pdmux-state="collecting"]')?.textContent).toContain('42');
		const missing = render(CommitDetail, {
			props: { commit: { sha: 'abc1234567' }, pending: pendingNote({ pending: 0 }, 'abc1234567890') },
		});
		expect(missing.container.querySelector('[data-pdmux-state="missing"]')?.textContent).toContain('git show abc123456789');
		// Nothing selected: the panel is hidden rather than showing an empty frame.
		const idle = render(CommitDetail, { props: {} });
		expect((idle.container.querySelector('[data-pdmux-detail]') as HTMLElement).hasAttribute('hidden')).toBe(true);
	});
});

describe('[TC-PDUI-146] the detail panel takes a height, and none by default', () => {
	it('applies the caller\'s height and marks itself as sized', () => {
		const commit = { sha: 'abc1234567', subject: 'fix: something' };

		// Unsized: no inline height at all, so a one-line commit gets a one-line panel
		// rather than a fixed frame with empty space under it.
		const auto = render(CommitDetail, { props: { commit } });
		const autoPanel = auto.container.querySelector('[data-pdmux-detail]') as HTMLElement;
		expect(autoPanel.style.height).toBe('');
		expect(autoPanel.dataset.pdmuxSized).toBeUndefined();

		const sized = render(CommitDetail, { props: { commit, height: 320 } });
		const panel = sized.container.querySelector('[data-pdmux-detail]') as HTMLElement;
		expect(panel.style.height).toBe('320px');
		// The marker is what lets the stylesheet give a deliberately resized panel more
		// of the column than a content-sized one.
		expect(panel.dataset.pdmuxSized).toBe('true');
	});
});

describe('[TC-PDUI-022] a patch is coloured by line kind and never rendered as markup', () => {
	it('marks hunks, additions and deletions', () => {
		const { container } = render(DiffView, {
			props: {
				files: [
					{
						path: 'a.ts',
						status: 'M',
						add: 1,
						del: 1,
						lines: ['@@ -1,2 +1,2 @@', '-old', '+new <b>not markup</b>', ' ctx'],
					},
				],
			},
		});
		const kinds = [...container.querySelectorAll('.pdmux-patch span')].map((n) => n.getAttribute('data-kind'));
		expect(kinds).toEqual(['hunk', 'del', 'add', 'ctx']);
		expect(container.querySelector('.pdmux-patch')?.innerHTML).not.toContain('<b>');
		expect(container.textContent).toContain('not markup');
	});

	it('handles a binary file, a truncated file and an empty list', () => {
		const binary = render(DiffView, { props: { files: [{ path: 'logo.png', binary: true, status: 'A' }] } });
		expect(binary.container.querySelector('.pdmux-patch')).toBeNull();
		expect(binary.container.textContent).toContain('Binary file');

		const partial = render(DiffView, {
			props: { files: [{ path: 'big.json', truncated: true, add: 800, del: 0, lines: ['+x'] }] },
		});
		expect(partial.container.querySelector('.pdmux-diff-head')?.textContent).toContain('partial');

		const empty = render(DiffView, { props: { files: [], note: '' } });
		expect(empty.container.querySelector('[data-pdmux-empty="diff"]')).not.toBeNull();
	});
});

describe('[TC-PDUI-023] the refs panel states where HEAD is and what has diverged', () => {
	const REPO_REFS = [
		{ name: 'main', kind: 'local' as const, sha: 'm1'.padEnd(40, '0'), ahead: 2, behind: 1 },
		{ name: 'feat/x', kind: 'local' as const, sha: 'f1'.padEnd(40, '0') },
		{ name: 'chore/old', kind: 'local' as const, sha: 'c1'.padEnd(40, '0'), gone: true },
		{ name: 'origin/main', kind: 'remote' as const, sha: 'm1'.padEnd(40, '0') },
		{ name: 'v1.0.0', kind: 'tag' as const, sha: 'a1'.padEnd(40, '0') },
		{ name: 'v0.9.0', kind: 'tag' as const, sha: 'a0'.padEnd(40, '0') },
	];

	it('groups by kind with counts, diverged first, and shortens every sha', () => {
		const { container } = render(GitRefPanel, {
			props: { head: { branch: 'main', sha: 'm1'.padEnd(40, '0'), upstream: 'origin/main', ahead: 2, behind: 1 }, refs: REPO_REFS },
		});
		const titles = [...container.querySelectorAll('.pdmux-refs-title')].map((n) => n.textContent?.trim());
		expect(titles).toEqual(['Local branches (3)', 'Remote branches (1)', 'Tags (2)']);
		// Diverged branches come first: that is what the panel is opened for.
		const locals = [...container.querySelectorAll('.pdmux-ref[data-kind="local"] .pdmux-ref-name')].map(
			(n) => n.textContent,
		);
		expect(locals[0]).toBe('main');
		expect(locals).toContain('chore/old');
		expect(container.querySelector('.pdmux-ref-div')?.textContent).toBe('↑2 ↓1');
		expect(container.querySelector('.pdmux-ref-sha')?.textContent).toBe('m100000');
		// Remote rows are only as old as the last fetch, and the panel says so.
		expect(container.textContent).toContain('last fetch');
	});

	it('says when an upstream is gone, for a branch and for HEAD', () => {
		const branchOnly = render(GitRefPanel, { props: { refs: REPO_REFS } });
		const gone = branchOnly.container.querySelector('.pdmux-ref[data-pdmux-ref="chore/old"] [data-pdmux-gone]');
		// A vanished upstream is the reason someone opens this panel, so it is a badge
		// rather than another arrow-and-number.
		expect(gone?.textContent).toContain('gone');

		const { container } = render(GitRefPanel, {
			props: { head: { branch: 'chore/old', upstream: 'origin/chore/old', gone: true }, refs: REPO_REFS },
		});
		const upstream = container.querySelector('[data-pdmux-head-upstream]');
		expect(upstream?.getAttribute('data-gone')).toBe('true');
		expect(upstream?.textContent).toContain('gone');
	});

	it('reports a detached HEAD, an in-sync branch and an empty repository', () => {
		const detached = render(GitRefPanel, {
			props: { head: { detached: true, sha: 'deadbeefcafe'.padEnd(40, '0') }, refs: [] },
		});
		const state = detached.container.querySelector('[data-pdmux-head-state]');
		expect(state?.getAttribute('data-detached')).toBe('true');
		expect(state?.textContent).toContain('detached @ deadbee');
		// Nothing to list is a sentence, not a blank column.
		expect(detached.container.querySelector('[data-pdmux-empty="refs"]')).not.toBeNull();

		const synced = render(GitRefPanel, {
			props: { head: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }, refs: [] },
		});
		expect(synced.container.querySelector('.pdmux-refs-up-state')?.textContent).toContain('in sync');
	});

	it('routes its wording through the consumer translator', () => {
		const t = (key: string, fallback: string): string => `[${key}]${fallback}`;
		const { container } = render(GitRefPanel, { props: { refs: REPO_REFS, t } });
		expect(container.querySelector('.pdmux-refs-title')?.textContent).toContain('[pdmux.refs.local]');
		expect(container.querySelector('.pdmux-refs-note')?.textContent).toContain('[pdmux.refs.fetchNote]');
	});
});

describe('[TC-PDUI-169] the graph and refs panels stay silent until there is an answer', () => {
	/**
	 * `ready: false` means "not asked yet". Rendering "No commits" then states a result
	 * for a repository nobody has heard back on — which is what the dock did for the
	 * first ~600ms of every refresh, in a column wide enough to read as a broken layout.
	 * The default stays `true` so a caller rendering from data it already holds is
	 * unaffected.
	 */
	it('withholds the empty message while unready, and gives it once ready', () => {
		const unreadyGraph = render(GitGraph, { props: { commits: [], ready: false } });
		expect(unreadyGraph.container.querySelector('[data-pdmux-empty="graph"]')).toBeNull();

		const readyGraph = render(GitGraph, { props: { commits: [], ready: true } });
		expect(readyGraph.container.querySelector('[data-pdmux-empty="graph"]')).not.toBeNull();

		// Unspecified means "the caller already has the data" — the old behaviour.
		const defaulted = render(GitGraph, { props: { commits: [] } });
		expect(defaulted.container.querySelector('[data-pdmux-empty="graph"]')).not.toBeNull();

		const unreadyRefs = render(GitRefPanel, { props: { refs: [], ready: false } });
		expect(unreadyRefs.container.querySelector('[data-pdmux-empty="refs"]')).toBeNull();

		const readyRefs = render(GitRefPanel, { props: { refs: [], ready: true } });
		expect(readyRefs.container.querySelector('[data-pdmux-empty="refs"]')).not.toBeNull();
	});
});
