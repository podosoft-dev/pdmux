<script lang="ts">
	/**
	 * A list of paths as the directories they live in.
	 *
	 * ⚠ THE GROUPING IS NOT DONE HERE. `treeOf()` in `@pdmux/core` owns it, including
	 * the rule that a chain of single-child directories folds into one row — that is
	 * a judgement with an edge case (never fold past a file), and a judgement in
	 * markup is a judgement nobody can unit-test.
	 *
	 * ⚠ AND NEITHER IS THE ROW CONTENT. The changed-file list draws `+9 −2 modified`
	 * and the repository listing draws a size; both are the same tree with different
	 * trailing text, so the caller passes a `meta` snippet and this stays one
	 * component. Two components would have meant two folding implementations, which
	 * is how the collapse edge case would come back.
	 *
	 * Recursive by way of a self-import (Svelte 5 deprecates `<svelte:self>`): a tree
	 * is the one shape where the component and the data have the same recursion, and
	 * flattening it here would mean re-deriving depth on every row.
	 */
	import type { FileTreeNode } from '@pdmux/core';
	import type { Snippet } from 'svelte';
	import { type Translate, translator } from '../i18n.js';
	// A self-import rather than `<svelte:self>`, which Svelte 5 deprecates.
	import FileTree from './FileTree.svelte';

	interface Props {
		nodes: readonly FileTreeNode<unknown>[];
		depth?: number;
		/** Which file row reads as chosen, if any. */
		selected?: string | null;
		onSelect?: (path: string) => void;
		/** Trailing content for a file row — stats, a size, nothing. */
		meta?: Snippet<[string]>;
		/**
		 * Drawn immediately after a file row, and only for the rows the caller wants
		 * it on — that is how a patch appears UNDER the file it belongs to instead of
		 * after the whole tree. A snippet rather than a slot because the row it hangs
		 * off is several levels down the recursion.
		 */
		extra?: Snippet<[string]>;
		/**
		 * Directories can be folded away.
		 *
		 * ⚠ OFF FOR A COMMIT'S CHANGED FILES, ON FOR A REPOSITORY LISTING. A commit
		 * touches a handful of paths and hiding them behind disclosure triangles is
		 * work for no reason; a repository is thousands, and without folding the
		 * `File tree` face is a scroll bar with a repository behind it.
		 */
		collapsible?: boolean;
		/** Paths of directories the caller is holding closed. */
		closed?: ReadonlySet<string>;
		onToggleDir?: (path: string) => void;
		t?: Translate;
	}

	let {
		nodes,
		depth = 0,
		selected = null,
		onSelect,
		meta,
		extra,
		collapsible = false,
		closed,
		onToggleDir,
		t,
	}: Props = $props();
	const tr = $derived(translator(t));

	const isClosed = (path: string): boolean => (collapsible ? (closed?.has(path) ?? false) : false);
</script>

{#if depth === 0 && nodes.length === 0}
	<p class="pdmux-meta" data-pdmux-tree-empty>{tr('pdmux.tree.empty', 'No files changed')}</p>
{/if}

<ul class="pdmux-tree" data-pdmux-tree={depth === 0 ? 'root' : undefined} style="--pdmux-tree-depth:{depth}">
	{#each nodes as node (node.path)}
		{#if node.kind === 'dir'}
			<li class="pdmux-tree-dir" data-pdmux-tree-dir={node.path}>
				{#if collapsible}
					<!-- A directory is a disclosure, never a selection: choosing a folder has
					     nothing to show, so it must not look like it does. -->
					<button
						type="button"
						class="pdmux-tree-toggle"
						data-pdmux-tree-toggle={node.path}
						aria-expanded={!isClosed(node.path)}
						onclick={() => onToggleDir?.(node.path)}
					>
						<span class="pdmux-tree-caret" aria-hidden="true">{isClosed(node.path) ? '▸' : '▾'}</span>
						<span class="pdmux-tree-label">{node.label}/</span>
					</button>
				{:else}
					<span class="pdmux-tree-label">{node.label}/</span>
				{/if}
				{#if !isClosed(node.path)}
					<FileTree
						nodes={node.children}
						depth={depth + 1}
						{selected}
						{onSelect}
						{meta}
						{extra}
						{collapsible}
						{closed}
						{onToggleDir}
						{t}
					/>
				{/if}
			</li>
		{:else}
			<li class="pdmux-tree-file" data-pdmux-tree-file={node.path}>
				<!-- A row that reveals something is a control, so it is a button: it has to
				     be reachable by keyboard and to announce which one is current. -->
				<button
					type="button"
					class="pdmux-file-row"
					data-pdmux-file-row={node.path}
					aria-current={node.path === selected ? 'true' : undefined}
					onclick={() => onSelect?.(node.path)}
				>
					<span class="pdmux-tree-label" title={node.path}>{node.label}</span>
					{#if meta}{@render meta(node.path)}{/if}
				</button>
				<!-- Inside the `li`, not after it: a `ul` may only hold `li`, and whatever
				     this is belongs to this row anyway. -->
				{#if extra}{@render extra(node.path)}{/if}
			</li>
		{/if}
	{/each}
</ul>
