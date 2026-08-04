<script lang="ts">
	/**
	 * Every file that existed at a commit, and the contents of whichever one is open.
	 *
	 * ⚠ THE LISTING IS NOT THE FILES. This draws names and sizes; a file's contents
	 * arrive only when its row is clicked, and the caller fetches them. A repository
	 * is thousands of paths and megabytes of text, and sending the second with the
	 * first would be the largest payload this product has for content nobody has
	 * asked to read.
	 *
	 * ⚠ AND A DIRECTORY IS NOT SELECTABLE. Choosing a folder has nothing to show, so
	 * it must not look as though it does — its row is a disclosure and nothing else.
	 */
	import { type FileTreeNode, treeOf } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import BlobView from './BlobView.svelte';
	import FileTree from './FileTree.svelte';

	interface Entry {
		path: string;
		size: number;
	}

	interface BlobInput {
		path: string;
		lines?: readonly string[];
		binary?: boolean;
		truncated?: boolean;
		error?: string | null;
	}

	interface Props {
		entries?: readonly Entry[];
		/** Paths of folded directories — the caller owns the set so it survives a redraw. */
		closed?: ReadonlySet<string>;
		onToggleDir?: (path: string) => void;
		selected?: string | null;
		onSelect?: (path: string) => void;
		blob?: BlobInput | null;
		loading?: boolean;
		/** The listing itself is on its way. */
		treeLoading?: boolean;
		/** Neither is coming — an agent too old, or one not replying. */
		unavailable?: boolean;
		blobUnavailable?: boolean;
		/** Paths left out by the entry cap, so the screen can say how many. */
		dropped?: number;
		t?: Translate;
	}

	let {
		entries = [],
		closed,
		onToggleDir,
		selected = null,
		onSelect,
		blob = null,
		loading = false,
		treeLoading = false,
		unavailable = false,
		blobUnavailable = false,
		dropped = 0,
		t,
	}: Props = $props();

	const tr = $derived(translator(t));
	const tree = $derived(treeOf(entries) as FileTreeNode<unknown>[]);
	const sizes = $derived(new Map(entries.map((entry) => [entry.path, entry.size])));

	/**
	 * Wide enough for two columns — the same threshold and the same reasoning as
	 * `FileList.svelte`, measured on the element because one viewport holds both a
	 * ~420px dock and a full-width window.
	 */
	const WIDE = 640;
	let host: HTMLDivElement | null = $state(null);
	let split = $state(false);

	$effect(() => {
		const node = host;
		if (!node || typeof ResizeObserver === 'undefined') return;
		const measure = (): void => {
			split = node.clientWidth >= WIDE;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});

	/** Bytes as something readable. A size is a hint, so one decimal is plenty. */
	function humanSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="pdmux-filepane" data-pdmux-filepane={split ? 'split' : 'stacked'} bind:this={host}>
	<div class="pdmux-filepane-list" data-pdmux-filepane-list>
		{#if treeLoading}
			<p class="pdmux-meta" data-pdmux-tree-state="loading">
				{tr('pdmux.repoTree.loading', 'Reading the file list…')}
			</p>
		{:else if unavailable}
			<!-- ⚠ A SENTENCE, NOT A SPINNER: an agent too old to know the frame logs it
			     and keeps its socket, so nothing is ever going to arrive. -->
			<p class="pdmux-meta" data-pdmux-tree-state="unavailable">
				{tr(
					'pdmux.repoTree.unavailable',
					'This host’s agent cannot list a commit’s files yet — update it to use this view',
				)}
			</p>
		{:else}
			<FileTree
				nodes={tree}
				{selected}
				{onSelect}
				meta={sizeMeta}
				extra={split ? undefined : inlineBlob}
				collapsible
				{closed}
				{onToggleDir}
				{t}
			/>
			{#if dropped > 0}
				<p class="pdmux-meta" data-pdmux-tree-dropped>
					{tr('pdmux.repoTree.dropped', '{count} more files are not listed')?.replace(
						'{count}',
						String(dropped),
					)}
				</p>
			{/if}
		{/if}
	</div>

	{#if split}
		<div class="pdmux-filepane-diff" data-pdmux-filepane-diff>
			<BlobView {blob} {loading} unavailable={blobUnavailable} {t} />
		</div>
	{/if}
</div>

{#snippet sizeMeta(path: string)}
	{@const size = sizes.get(path)}
	{#if size !== undefined}
		<span class="pdmux-tree-stat" data-pdmux-tree-size>{humanSize(size)}</span>
	{/if}
{/snippet}

{#snippet inlineBlob(path: string)}
	{#if path === selected}
		<div class="pdmux-file-patch" data-pdmux-file-blob={path}>
			<BlobView {blob} {loading} unavailable={blobUnavailable} {t} />
		</div>
	{/if}
{/snippet}
