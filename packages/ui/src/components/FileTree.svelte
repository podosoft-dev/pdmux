<script lang="ts">
	/**
	 * A commit's changed files as the directories they live in.
	 *
	 * ⚠ THE GROUPING IS NOT DONE HERE. `fileTree()` in `@pdmux/core` owns it,
	 * including the rule that a chain of single-child directories folds into one
	 * row — that is a judgement with an edge case (never fold past a file), and a
	 * judgement in markup is a judgement nobody can unit-test.
	 *
	 * Recursive by way of a self-import (Svelte 5 deprecates `<svelte:self>`): a
	 * tree is the one shape where the component and the data have the same
	 * recursion, and flattening it here would mean re-deriving depth on every row.
	 */
	import type { FileTreeNode } from '@pdmux/core';
	import type { Snippet } from 'svelte';
	import { type Translate, translator } from '../i18n.js';
	// A self-import rather than `<svelte:self>`, which Svelte 5 deprecates.
	import FileTree from './FileTree.svelte';

	interface Props {
		nodes: readonly FileTreeNode[];
		depth?: number;
		/** Which file row reads as chosen, if any. */
		selected?: string | null;
		onSelect?: (path: string) => void;
		/**
		 * Drawn immediately after a file row, and only for the rows the caller wants
		 * it on — that is how the patch appears UNDER the file it belongs to instead
		 * of after the whole tree. A snippet rather than a slot because the row it
		 * hangs off is several levels down the recursion.
		 */
		extra?: Snippet<[string]>;
		t?: Translate;
	}

	let { nodes, depth = 0, selected = null, onSelect, extra, t }: Props = $props();
	const tr = $derived(translator(t));

	/**
	 * The one-letter git status as a word.
	 *
	 * ⚠ NEVER COLOUR ALONE — the same rule the host cards keep. A red row and a
	 * green row are one row to a reader who cannot separate the hues, so the state
	 * is spelled out and the colour is the accent.
	 */
	function statusLabel(status: string, translate: Translate): string {
		if (status === 'A') return translate('pdmux.tree.added', 'added');
		if (status === 'D') return translate('pdmux.tree.deleted', 'deleted');
		if (status === 'R') return translate('pdmux.tree.renamed', 'renamed');
		return translate('pdmux.tree.modified', 'modified');
	}
</script>

{#if depth === 0 && nodes.length === 0}
	<p class="pdmux-meta" data-pdmux-tree-empty>{tr('pdmux.tree.empty', 'No files changed')}</p>
{/if}

<ul class="pdmux-tree" data-pdmux-tree={depth === 0 ? 'root' : undefined} style="--pdmux-tree-depth:{depth}">
	{#each nodes as node (node.path)}
		{#if node.kind === 'dir'}
			<li class="pdmux-tree-dir" data-pdmux-tree-dir={node.path}>
				<span class="pdmux-tree-label">{node.label}/</span>
				<FileTree nodes={node.children} depth={depth + 1} {selected} {onSelect} {extra} {t} />
			</li>
		{:else}
			<li class="pdmux-tree-file" data-pdmux-tree-file={node.path}>
				<!-- A row that reveals a patch is a control, so it is a button: it has to be
				     reachable by keyboard and to announce which one is current. -->
				<button
					type="button"
					class="pdmux-file-row"
					data-pdmux-file-row={node.path}
					aria-current={node.path === selected ? 'true' : undefined}
					onclick={() => onSelect?.(node.path)}
				>
					<span class="pdmux-tree-label" title={node.path}>{node.label}</span>
					<span class="pdmux-tree-stat" data-pdmux-tree-add>+{node.file.add}</span>
					<span class="pdmux-tree-stat" data-pdmux-tree-del>−{node.file.del}</span>
					<span class="pdmux-tree-status" data-pdmux-tree-status={node.file.status}>
						{statusLabel(node.file.status, tr)}
					</span>
				</button>
				<!-- Inside the `li`, not after it: a `ul` may only hold `li`, and the patch
				     belongs to this row anyway. -->
				{#if extra}{@render extra(node.path)}{/if}
			</li>
		{/if}
	{/each}
</ul>
