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
	import { type ChangedFile, type PendingNote, fileTree } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import DiffView from './DiffView.svelte';
	import FileTree from './FileTree.svelte';

	interface CommitRow {
		sha: string;
		subject?: string;
		author?: string;
		date?: number | null;
		parents?: readonly string[];
		refs?: readonly string[];
	}

	/** The three faces of one commit, in the order a person reads them. */
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
	let tab = $state<Tab>('changes');
	/**
	 * ⚠ AND IT RESETS WHEN THE COMMIT DOES. Keeping "File tree" selected across a
	 * click opens the next commit on a view of a different commit's paths, which
	 * reads as the panel not having updated at all.
	 */
	$effect(() => {
		commit?.sha;
		tab = 'changes';
	});

	const files = $derived((detail?.files ?? []) as readonly ChangedFile[]);
	const tree = $derived(fileTree(files));
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
		<h3 data-pdmux-subject>{commit.subject ?? ''}</h3>
		<p class="pdmux-meta" data-pdmux-meta>{commit.author ?? ''} · {dateText} · {commit.sha}</p>
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
			<!-- ⚠ PLAIN BUTTONS, NOT A COMPONENT LIBRARY. `@pdmux/ui` is installable by
			     a project with its own design system, so its imports are restricted to
			     relative paths and `@pdmux/*` — a shadcn tab would break that contract
			     (and its test) the moment it was added. -->
			<div class="pdmux-tabs" role="tablist" data-pdmux-tabs>
				{#each [['commit', tr('pdmux.detail.tabCommit', 'Commit')], ['changes', `${tr('pdmux.detail.tabChanges', 'Changes')} ${files.length}${detail.truncated || detail.dropped ? ' ⚠' : ''}`], ['tree', tr('pdmux.detail.tabTree', 'File tree')]] as [id, label] (id)}
					<button
						type="button"
						role="tab"
						class="pdmux-tab"
						data-pdmux-tab={id}
						aria-selected={tab === id}
						onclick={() => (tab = id as Tab)}>{label}</button
					>
				{/each}
			</div>

			{#if tab === 'commit'}
				<div data-pdmux-tabpanel="commit">
					{#if detail.body}
						<pre class="pdmux-patch" data-pdmux-body>{detail.body}{detail.bodyTruncated ? '\n…' : ''}</pre>
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
						<dd data-pdmux-sha>{commit.sha}</dd>
						{#if commit.parents?.length}
							<dt>{tr('pdmux.detail.parents', 'Parents')}</dt>
							<dd data-pdmux-parents>{commit.parents.map((p) => p.slice(0, 7)).join(' · ')}</dd>
						{/if}
						{#if commit.refs?.length}
							<dt>{tr('pdmux.detail.refs', 'In')}</dt>
							<dd data-pdmux-refs>{commit.refs.join(' · ')}</dd>
						{/if}
					</dl>
				</div>
			{:else if tab === 'changes'}
				<div data-pdmux-tabpanel="changes">
					<DiffView files={detail.files ?? []} note={droppedNote} {t} />
				</div>
			{:else}
				<div data-pdmux-tabpanel="tree">
					<FileTree nodes={tree} {t} />
				</div>
			{/if}
		{/if}
	{/if}
</div>
