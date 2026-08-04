<script lang="ts">
	/**
	 * A commit's changed files, and the patch of whichever one is chosen.
	 *
	 * ⚠ THE SHAPE DEPENDS ON HOW MUCH ROOM THERE IS, and that is measured, not
	 * guessed from the viewport. The same viewport holds a ~420px dock and a
	 * full-width detached git window, so a media query would answer for the wrong
	 * one. `ResizeObserver` on this element is the same approach `GitGraph.svelte`
	 * already takes for its lanes.
	 *
	 *  - wide   — list on the left, patch on the right (this is Fork's Changes tab)
	 *  - narrow — the patch opens UNDER the file it belongs to, because two columns
	 *    of ~200px each show neither a path nor a line of code
	 *
	 * `stack` forces the second shape at any width: Fork's Commit tab is a list with
	 * the patch toggling open under the row, however wide the window is.
	 *
	 * The controls that choose a face are NOT here: they are chrome, the app draws
	 * them with its design system (`.claude/rules/ui-changes.md`).
	 */
	import { type ChangedFile, fileTree } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import DiffView from './DiffView.svelte';
	import FileTree from './FileTree.svelte';

	interface Props {
		files?: readonly ChangedFile[];
		/** Always stacked — the patch toggles under its row rather than beside it. */
		stack?: boolean;
		selected?: string | null;
		onSelect?: (path: string) => void;
		/** Shown after the list, e.g. "3 files omitted by the size cap". */
		note?: string;
		t?: Translate;
	}

	let { files = [], stack = false, selected = null, onSelect, note = '', t }: Props = $props();

	const tr = $derived(translator(t));
	const tree = $derived(fileTree(files));
	const byPath = $derived(new Map(files.map((file) => [file.path, file])));
	const chosen = $derived(selected === null ? null : (byPath.get(selected) ?? null));

	/**
	 * Wide enough for two columns.
	 *
	 * 640 is where a 40% list column still fits `packages/ui/src/components/` before
	 * ellipsis AND the patch column still fits an 80-column line, which is the pair
	 * of things two columns exist to show. Below it they fight and both lose.
	 */
	const WIDE = 640;
	let host: HTMLDivElement | null = $state(null);
	let roomy = $state(false);
	const split = $derived(!stack && roomy);

	$effect(() => {
		const node = host;
		if (!node || typeof ResizeObserver === 'undefined') return;
		const measure = (): void => {
			roomy = node.clientWidth >= WIDE;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});

	/** The one-letter git status as a word. */
	function statusLabel(status: string, translate: Translate): string {
		if (status === 'A') return translate('pdmux.tree.added', 'added');
		if (status === 'D') return translate('pdmux.tree.deleted', 'deleted');
		if (status === 'R') return translate('pdmux.tree.renamed', 'renamed');
		return translate('pdmux.tree.modified', 'modified');
	}
</script>

<div class="pdmux-filepane" data-pdmux-filepane={split ? 'split' : 'stacked'} bind:this={host}>
	<div class="pdmux-filepane-list" data-pdmux-filepane-list>
		<FileTree
			nodes={tree}
			{selected}
			{onSelect}
			meta={stats}
			extra={split ? undefined : inlinePatch}
			{t}
		/>
		{#if note}<p class="pdmux-meta">{note}</p>{/if}
	</div>

	{#if split}
		<div class="pdmux-filepane-diff" data-pdmux-filepane-diff>
			{#if chosen}
				<DiffView files={[chosen]} {t} />
			{/if}
		</div>
	{/if}
</div>

{#snippet stats(path: string)}
	{@const file = byPath.get(path)}
	{#if file}
		<span class="pdmux-tree-stat" data-pdmux-tree-add>+{file.add}</span>
		<span class="pdmux-tree-stat" data-pdmux-tree-del>−{file.del}</span>
		<!-- ⚠ NEVER COLOUR ALONE — the same rule the host cards keep. A red row and a
		     green row are one row to a reader who cannot separate the hues. -->
		<span class="pdmux-tree-status" data-pdmux-tree-status={file.status}>
			{statusLabel(file.status, tr)}
		</span>
	{/if}
{/snippet}

{#snippet inlinePatch(path: string)}
	{#if path === selected}
		{@const file = byPath.get(path)}
		{#if file}
			<div class="pdmux-file-patch" data-pdmux-file-patch={path}>
				<DiffView files={[file]} {t} />
			</div>
		{/if}
	{/if}
{/snippet}
