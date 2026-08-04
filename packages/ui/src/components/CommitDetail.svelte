<script lang="ts">
	/**
	 * What one clicked row is about.
	 *
	 * The header renders from the ROW data, which is instant and always available; the
	 * message body, the file list and the patch arrive separately because they are
	 * fetched on the click — carrying them in the list feed made it several times
	 * larger for content that is never rendered until somebody clicks.
	 *
	 * ⚠ This panel stays INSIDE the viewport (see styles.css): when it did not, its
	 * content existed in the DOM thousands of pixels below the fold and clicking a
	 * commit looked like it did nothing.
	 */
	import { type ChangedFile, type PendingNote } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import FileList from './FileList.svelte';
	import RepoTreeView from './RepoTreeView.svelte';

	interface CommitRow {
		sha: string;
		subject?: string;
		author?: string;
		date?: number | null;
		parents?: readonly string[];
		refs?: readonly string[];
	}

	/**
	 * The three faces of one commit, as the latest Fork for macOS draws them.
	 *
	 *  - `commit`  — the facts, then the changed files; a row toggles its patch open
	 *  - `changes` — the changed files as a tree, with the chosen file's patch beside it
	 *  - `tree`    — every file that EXISTED at the commit, with the chosen file's contents
	 *
	 * ⚠ THE THIRD ONE IS NOT A REDRAW OF THE SECOND. `changes` lists what the commit
	 * touched; `tree` lists the whole repository at that point and shows file contents
	 * rather than patches. They were once conflated into a tree-versus-list toggle on
	 * one list, which is a different product — and a research mistake: that description
	 * came from an older Windows build.
	 */
	type Tab = 'commit' | 'changes' | 'tree';

	interface DetailInput {
		body?: string;
		bodyTruncated?: boolean;
		/** Only what the row lacks — see the contract's note on `commitDetail`. */
		authorEmail?: string;
		committer?: string;
		committerEmail?: string;
		committerDate?: number | null;
		truncated?: boolean;
		files?: readonly {
			path: string;
			oldPath?: string | null;
			status?: 'A' | 'M' | 'D' | 'R';
			add?: number;
			del?: number;
			binary?: boolean;
			truncated?: boolean;
			lines?: readonly string[];
		}[];
		dropped?: number;
	}

	/**
	 * What a missing patch says, per kind.
	 *
	 * Three states that look identical (no patch) and mean opposite things: it is on
	 * its way, it is never coming, or it was on its way and we stopped waiting. A
	 * ternary chain here would be the unreadable kind, so it is a function.
	 */
	function noteText(note: PendingNote, tr: Translate): string {
		if (note.kind === 'collecting') {
			return `${tr('pdmux.detail.collecting', 'Changes are still being collected')} (${note.pending})`;
		}
		if (note.kind === 'timeout') {
			return `${tr('pdmux.detail.notArrived', 'The changes have not arrived yet')} — git show ${note.shortSha}`;
		}
		return `${tr('pdmux.detail.missing', 'Changes were not collected for this commit')} — git show ${note.shortSha}`;
	}

	interface Props {
		commit?: CommitRow | null;
		detail?: DetailInput | null;
		/** Set when there is no detail: says whether one is still being collected. */
		pending?: PendingNote | null;
		loading?: boolean;
		/**
		 * Ask for the patch again. Offered ONLY after a wait was given up on (`timeout`):
		 * a button on "still collecting" invites a poll storm, and one on "never
		 * collected" would do nothing at all.
		 */
		onRetry?: () => void;
		/** Formats a commit timestamp; the caller owns locale and timezone. */
		formatDate?: (epochSeconds: number) => string;
		/**
		 * Height in px when the user has resized the panel; `null` means "as tall as the
		 * content", which is what a one-line commit message should get. The stylesheet
		 * still caps it at a share of the column, so a large number cannot squeeze the
		 * graph out or make the page scroll.
		 */
		height?: number | null;
		/** Which of the three faces to draw. The app owns the control that sets it. */
		view?: Tab;
		/** Which file's patch is showing, on the `commit` and `changes` faces. */
		selectedPath?: string | null;
		onSelectFile?: (path: string) => void;
		/** The `tree` face: the repository listing and the file being read. */
		treeEntries?: readonly { path: string; size: number }[];
		treeDropped?: number;
		treeLoading?: boolean;
		treeUnavailable?: boolean;
		closedDirs?: ReadonlySet<string>;
		onToggleDir?: (path: string) => void;
		treePath?: string | null;
		onSelectTreeFile?: (path: string) => void;
		blob?: {
			path: string;
			lines?: readonly string[];
			binary?: boolean;
			truncated?: boolean;
			error?: string | null;
		} | null;
		blobLoading?: boolean;
		blobUnavailable?: boolean;
		t?: Translate;
	}

	let {
		commit = null,
		detail = null,
		pending = null,
		loading = false,
		onRetry,
		formatDate,
		height = null,
		view = 'changes',
		selectedPath = null,
		onSelectFile,
		treeEntries = [],
		treeDropped = 0,
		treeLoading = false,
		treeUnavailable = false,
		closedDirs,
		onToggleDir,
		treePath = null,
		onSelectTreeFile,
		blob = null,
		blobLoading = false,
		blobUnavailable = false,
		t,
	}: Props = $props();

	const tr = $derived(translator(t));
	/**
	 * Is a patch actually on its way? Only then is it worth holding its space (see the
	 * `data-pdmux-awaiting` rule in the stylesheet). A sha whose detail was never
	 * collected, or one we stopped waiting for, is not going to fill the panel — holding
	 * 45% of the column for a single line of text would be reserving space for nothing.
	 */
	const awaiting = $derived(Boolean(commit) && !detail && (loading || pending?.kind === 'collecting'));
	const dateText = $derived(
		commit?.date == null ? '' : (formatDate ?? ((s: number) => new Date(s * 1000).toISOString()))(commit.date),
	);
	/**
	 * ⚠ IT OPENS ON THE CHANGES, NOT ON THE MESSAGE. The tabs are ordered the way a
	 * person reads them, but the diff is what the click was FOR — and it is what
	 * this panel showed before there were tabs, so defaulting to the message would
	 * have made the most common thing cost an extra click to get back.
	 *
	 * The subject is already on the row and in the header above; the full message
	 * is the part worth a tab, not the part worth the default.
	 */
	/**
	 * ⚠ THE TAB CHROME IS NOT DRAWN HERE, AND THAT IS THE FIX. This package must not
	 * import a design system — `[TC-PDUI-030]` bans shadcn/bits-ui so that a project
	 * with its own can install it — so any control it draws is a lookalike, and a
	 * hand-rolled tab strip sitting under a product built entirely from shadcn reads
	 * as exactly what it is. The app owns the tabs (real `Tabs`), this owns the three
	 * panels, and the seam is one prop. (Ordinary self-contained libraries are fine:
	 * the file view below highlights with `highlight.js`.)
	 */
	const tab = $derived(view);


	const files = $derived((detail?.files ?? []) as readonly ChangedFile[]);
	/**
	 * The committer is drawn only when it differs from the author.
	 *
	 * On the overwhelming majority of commits the two are the same person and the
	 * same second, and printing both is two lines that say one thing. It diverges
	 * after a rebase, a cherry-pick or a patch applied on somebody's behalf — so its
	 * presence is itself the signal.
	 */
	const committerDiffers = $derived(
		Boolean(detail?.committer) &&
			(detail?.committer !== commit?.author || detail?.committerEmail !== detail?.authorEmail),
	);
	const committerDateText = $derived(
		detail?.committerDate == null
			? ''
			: (formatDate ?? ((s: number) => new Date(s * 1000).toISOString()))(detail.committerDate),
	);
	/** The sha, as everything else in this product writes one. */
	const shortSha = $derived((commit?.sha ?? '').slice(0, 12));

	/**
	 * A long commit message is folded to its first few lines.
	 *
	 * ⚠ THE PANEL IS A FIXED SHARE OF THE COLUMN, so a message with a design document
	 * in it pushes the file list off the bottom and the face opens on prose nobody
	 * asked for. Five lines is a subject plus a paragraph — enough to know whether the
	 * rest is worth opening.
	 *
	 * ⚠ COUNTED, NOT MEASURED. `scrollHeight > clientHeight` would answer the same
	 * question and answers it differently before fonts settle, which is the class of
	 * first-paint bug this codebase already keeps a rule about. Lines are in the data.
	 */
	const MESSAGE_LINES = 5;
	let messageOpen = $state(false);
	const messageLong = $derived((detail?.body ?? '').split('\n').length > MESSAGE_LINES);
	// Folding belongs to the message, so a different commit starts folded again.
	$effect(() => {
		commit?.sha;
		messageOpen = false;
	});
	const droppedNote = $derived(
		detail?.dropped
			? `+${detail.dropped} ${tr('pdmux.detail.droppedFiles', 'files omitted by the size cap')}`
			: '',
	);
</script>

<div
	class="pdmux pdmux-detail"
	data-pdmux-detail
	data-pdmux-sized={height == null ? undefined : 'true'}
	{...awaiting ? { 'data-pdmux-awaiting': 'true' } : {}}
	style={height == null ? undefined : `height:${height}px`}
	hidden={!commit}
>
	{#if commit}
		<!--
			⚠ THE HEADER IS A SEPARATE REGION FROM THE BODY, and it is pinned.

			What a commit IS (its subject, who wrote it, its sha) does not change while
			you read what it DID, so it must not scroll away underneath a patch — and
			without a boundary the two ran together as one wall of text at the same
			weight. The rule that comes out of it: every face is `header` + `body`, the
			header states identity, the body is what you scroll.
		-->
		<header class="pdmux-detail-head" data-pdmux-detail-head>
			<h3 data-pdmux-subject>{commit.subject ?? ''}</h3>
			<p class="pdmux-meta" data-pdmux-meta>
				<span data-pdmux-meta-author>{commit.author ?? ''}</span>
				<span class="pdmux-sep" aria-hidden="true">·</span>
				<span>{dateText}</span>
				<span class="pdmux-sep" aria-hidden="true">·</span>
				<code class="pdmux-sha">{shortSha}</code>
			</p>
		</header>
		{#if loading}
			<p class="pdmux-meta" data-pdmux-state="loading">{tr('pdmux.detail.loading', 'Loading changes…')}</p>
		{:else if pending}
			<p class="pdmux-meta" data-pdmux-state={pending.kind}>{noteText(pending, tr)}</p>
			{#if pending.kind === 'timeout' && onRetry}
				<button
					type="button"
					class="pdmux-detail-retry"
					data-pdmux-retry
					onclick={() => onRetry?.()}>{tr('pdmux.detail.retry', 'Try again')}</button
				>
			{/if}
		{:else if detail}
			{#if tab === 'commit'}
				<div class="pdmux-detail-body" data-pdmux-tabpanel="commit">
					<!-- ⚠ THE FACTS ARE A SECTION, NOT LOOSE LINES. Message, identity and
					     files are three answers to three questions; run together at one
					     weight they read as one paragraph nobody scans. -->
					<section class="pdmux-section" data-pdmux-section="about">
							{#if detail.body}
							<pre
								class="pdmux-patch pdmux-body"
								data-pdmux-body
								data-pdmux-body-folded={messageLong && !messageOpen ? 'true' : undefined}
								style={messageLong && !messageOpen ? `--pdmux-body-lines:${MESSAGE_LINES}` : undefined}
							>{detail.body}{detail.bodyTruncated ? '\n…' : ''}</pre>
							{#if messageLong}
								<!-- An inline disclosure on content the package owns, like the tree's
								     directory rows. The TAB chrome is the app's; this is not chrome. -->
								<button
									type="button"
									class="pdmux-more"
									data-pdmux-body-toggle
									aria-expanded={messageOpen}
									onclick={() => (messageOpen = !messageOpen)}
								>
									{messageOpen
										? tr('pdmux.detail.showLess', 'Show less')
										: tr('pdmux.detail.showMore', 'Show more')}
								</button>
							{/if}
						{/if}
						<dl class="pdmux-facts" data-pdmux-facts>
							<dt>{tr('pdmux.detail.authored', 'Authored')}</dt>
							<dd>{commit.author ?? ''}{detail.authorEmail ? ` <${detail.authorEmail}>` : ''} · {dateText}</dd>
							{#if committerDiffers}
								<!-- Present only when it says something the author line does not. -->
								<dt data-pdmux-committer>{tr('pdmux.detail.committed', 'Committed')}</dt>
								<dd>{detail.committer}{detail.committerEmail ? ` <${detail.committerEmail}>` : ''} · {committerDateText}</dd>
							{/if}
							<dt>{tr('pdmux.detail.sha', 'SHA')}</dt>
							<dd><code class="pdmux-sha" data-pdmux-sha>{commit.sha}</code></dd>
							{#if commit.parents?.length}
								<dt>{tr('pdmux.detail.parents', 'Parents')}</dt>
								<dd data-pdmux-parents>
									{#each commit.parents as parent (parent)}<code class="pdmux-sha">{parent.slice(0, 7)}</code>{/each}
								</dd>
							{/if}
							{#if commit.refs?.length}
								<dt>{tr('pdmux.detail.refs', 'In')}</dt>
								<dd data-pdmux-refs>
									{#each commit.refs as ref (ref)}<span class="pdmux-tag">{ref}</span>{/each}
								</dd>
							{/if}
						</dl>
					</section>
					<section class="pdmux-section" data-pdmux-section="files">
						<h4 class="pdmux-section-title">
							{tr('pdmux.detail.files', 'Changed files')}
							<span class="pdmux-count">{files.length}</span>
						</h4>
					<!-- ⚠ THE FILE LIST IS ON THIS FACE TOO. Fork's Commit tab has shown the
					     full list of changes since 1.0.70, and the reason holds here: what a
					     commit says and what it touched are one question. Splitting them made
					     the message face a dead end you had to leave to learn anything. -->
					<!-- ⚠ STACKED AT ANY WIDTH. Fork's Commit tab is a list whose rows toggle
					     their patch open underneath; the side-by-side shape belongs to the
					     Changes tab, and having both faces look identical when the window is
					     wide would make the tabs pointless. -->
					<FileList
							{files}
							stack
							selected={selectedPath}
							onSelect={onSelectFile}
							note={droppedNote}
							{t}
						/>
					</section>
				</div>
			{:else if tab === 'changes'}
				<div class="pdmux-detail-body" data-pdmux-tabpanel="changes">
					<FileList {files} selected={selectedPath} onSelect={onSelectFile} note={droppedNote} {t} />
				</div>
			{:else}
				<div class="pdmux-detail-body" data-pdmux-tabpanel="tree">
					<RepoTreeView
						entries={treeEntries}
						dropped={treeDropped}
						{treeLoading}
						unavailable={treeUnavailable}
						closed={closedDirs}
						{onToggleDir}
						selected={treePath}
						onSelect={onSelectTreeFile}
						{blob}
						loading={blobLoading}
						{blobUnavailable}
						{t}
					/>
				</div>
			{/if}
		{/if}
	{/if}
</div>
