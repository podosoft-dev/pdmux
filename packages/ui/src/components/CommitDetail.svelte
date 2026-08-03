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
	import type { PendingNote } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import DiffView from './DiffView.svelte';

	interface CommitRow {
		sha: string;
		subject?: string;
		author?: string;
		date?: number | null;
	}

	interface DetailInput {
		body?: string;
		bodyTruncated?: boolean;
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
			{#if detail.body}
				<pre class="pdmux-patch" data-pdmux-body>{detail.body}{detail.bodyTruncated ? '\n…' : ''}</pre>
			{/if}
			{#if detail.files?.length}
				<h3 data-pdmux-filecount>{tr('pdmux.detail.files', 'Changed files')} {detail.files.length}</h3>
			{/if}
			<DiffView files={detail.files ?? []} note={droppedNote} {t} />
		{/if}
	{/if}
</div>
