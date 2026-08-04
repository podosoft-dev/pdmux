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
	 *  - wide  — list on the left, patch on the right (this is Fork's layout)
	 *  - narrow — the patch opens UNDER the file it belongs to, because two columns
	 *    of ~200px each show neither a path nor a line of code
	 *
	 * The controls that choose tree-vs-list and expand-all are NOT here: they are
	 * chrome, the app draws them with its design system, and this takes their
	 * answers as props (see `.claude/rules/ui-changes.md`).
	 */
	import { type ChangedFile, fileList, fileTree } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import DiffView from './DiffView.svelte';
	import FileTree from './FileTree.svelte';

	interface Props {
		files?: readonly ChangedFile[];
		/** Grouped by directory, or flat. Fork puts this behind one button on the list. */
		view?: 'tree' | 'list';
		/** Every patch at once — Fork calls it "Expand All". */
		expandAll?: boolean;
		selected?: string | null;
		onSelect?: (path: string) => void;
		/** Shown after the list, e.g. "3 files omitted by the size cap". */
		note?: string;
		t?: Translate;
	}

	let { files = [], view = 'tree', expandAll = false, selected = null, onSelect, note = '', t }: Props = $props();

	const tr = $derived(translator(t));
	const tree = $derived(fileTree(files));
	const flat = $derived(fileList(files));
	const chosen = $derived(files.find((file) => file.path === selected) ?? null);

	/**
	 * Wide enough for two columns.
	 *
	 * 640 is where a 40% list column still fits `packages/ui/src/components/` before
	 * ellipsis AND the patch column still fits an 80-column line, which is the pair
	 * of things two columns exist to show. Below it they fight and both lose.
	 */
	const WIDE = 640;
	let host: HTMLDivElement | null = $state(null);
	let wide = $state(false);

	$effect(() => {
		const node = host;
		if (!node || typeof ResizeObserver === 'undefined') return;
		const measure = (): void => {
			wide = node.clientWidth >= WIDE;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});

	/** One file's patch, in the shape `DiffView` reads. */
	const chosenAsList = $derived(chosen ? [chosen] : []);
</script>

<div class="pdmux-filepane" data-pdmux-filepane={wide ? 'split' : 'stacked'} bind:this={host}>
	<div class="pdmux-filepane-list" data-pdmux-filepane-list>
		{#if view === 'tree'}
			<FileTree nodes={tree} {selected} {onSelect} extra={wide ? undefined : inlinePatch} {t} />
		{:else if flat.length === 0}
			<p class="pdmux-meta" data-pdmux-tree-empty>{tr('pdmux.tree.empty', 'No files changed')}</p>
		{:else}
			<ul class="pdmux-tree" data-pdmux-tree="flat" style="--pdmux-tree-depth:0">
				{#each flat as file (file.path)}
					<li class="pdmux-tree-file" data-pdmux-tree-file={file.path}>
						<button
							type="button"
							class="pdmux-file-row"
							data-pdmux-file-row={file.path}
							aria-current={file.path === selected ? 'true' : undefined}
							onclick={() => onSelect?.(file.path)}
						>
							<!-- The whole path, because a flat list without directories cannot tell
							     two `index.ts` apart. It ellipsises from the LEFT (see styles.css),
							     so the filename survives and the directory is what gets cut. -->
							<span class="pdmux-tree-label" title={file.path}>{file.path}</span>
							<span class="pdmux-tree-stat" data-pdmux-tree-add>+{file.add}</span>
							<span class="pdmux-tree-stat" data-pdmux-tree-del>−{file.del}</span>
						</button>
						{#if !wide}{@render inlinePatch(file.path)}{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if note}<p class="pdmux-meta">{note}</p>{/if}
	</div>

	{#if wide}
		<div class="pdmux-filepane-diff" data-pdmux-filepane-diff>
			{#if expandAll}
				<DiffView {files} {t} />
			{:else if chosen}
				<DiffView files={chosenAsList} {t} />
			{:else}
				<p class="pdmux-meta" data-pdmux-empty="file">
					{tr('pdmux.files.choose', 'Choose a file to see what changed in it')}
				</p>
			{/if}
		</div>
	{/if}
</div>

<!--
	The patch that hangs under one row while the pane is stacked.

	⚠ It renders for the CHOSEN row only, and `expandAll` widens that to every row —
	which is what makes "Expand All" mean the same thing in both shapes.
-->
{#snippet inlinePatch(path: string)}
	{#if expandAll || path === selected}
		{@const file = files.find((candidate) => candidate.path === path)}
		{#if file}
			<div class="pdmux-file-patch" data-pdmux-file-patch={path}>
				<DiffView files={[file]} {t} />
			</div>
		{/if}
	{/if}
{/snippet}
