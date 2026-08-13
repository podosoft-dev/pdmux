<script lang="ts">
	/**
	 * A host's files, under the account the agent runs as.
	 *
	 * ⚠ ONE DIRECTORY AT A TIME, NOT A TREE, AND THAT IS NOT A SIMPLIFICATION. The
	 * tree beside it (`FileTree` + `treeOf`) is built for a COMPLETE flat list —
	 * a commit's changed files, a repository at a sha — and it earns two behaviours
	 * from that: a directory exists only if a file inside it does, and a chain of
	 * single-child directories folds into one row. Both are right there and wrong
	 * here. An empty directory is a real thing a person needs to see, and folding
	 * `a/b/c` into one row hides the levels this view exists to walk. A remote
	 * listing also arrives one directory per request, so a tree would be a shape
	 * the data never has.
	 *
	 * ⚠ THERE IS NO WAY UP OUT OF THE ROOT, BY CONSTRUCTION. The path bar starts
	 * at the home directory and the parent of the root is the root — so the server
	 * is never asked for a path outside it. The agent would refuse anyway (its
	 * handle cannot leave the home), but a control that produces a refusal is a
	 * control that should not have been drawn.
	 *
	 * ⚠ CONTENT ONLY — the host picker, the path field and the toolbar are the app's
	 * (`ui-changes.md`: controls are shadcn, drawn by `apps/web`; panels are drawn
	 * here). This component paints the listing and the preview and reports clicks.
	 */
	import { fileKindOf } from '@pdmux/core';
	import type { FsDirView, FsFileView, SelectMode } from '../types.js';
	import { type Translate, translator } from '../i18n.js';
	import BlobView from './BlobView.svelte';

	interface Props {
		/** The directory being shown, or null while the first one is on its way. */
		dir?: FsDirView | null;
		/** Relative path of the directory shown — '' is the home directory. */
		path?: string;
		loading?: boolean;
		/** The agent cannot browse (too old, or no home). The panel says so. */
		unavailable?: boolean;
		/** No host chosen yet: the panel is empty on purpose, not broken. */
		idle?: boolean;
		/** Names (not paths) selected in the directory shown. */
		selected?: readonly string[];
		/** The file being previewed, if any. */
		file?: FsFileView | null;
		fileLoading?: boolean;
		/** An image being previewed — a URL the browser loads itself. */
		image?: { path: string; url: string } | null;
		t?: Translate;
		onOpenDir?: (path: string) => void;
		/** A click on a row. Directories navigate; files select and preview. */
		onSelect?: (name: string, mode: SelectMode) => void;
		onClosePreview?: () => void;
	}

	let {
		dir = null,
		path = '',
		loading = false,
		unavailable = false,
		idle = false,
		selected = [],
		file = null,
		fileLoading = false,
		image = null,
		t,
		onOpenDir,
		onSelect,
		onClosePreview,
	}: Props = $props();

	const tr = $derived(translator(t));
	const chosen = $derived(new Set(selected));
	const join = (name: string): string => (path ? `${path}/${name}` : name);

	/**
	 * ⚠ THE MODIFIER IS READ HERE AND NAMED, NOT PASSED ON AS AN EVENT. The rule
	 * ("cmd on a Mac, ctrl elsewhere") is one decision, and leaving it to each caller
	 * is how two callers end up disagreeing about it.
	 */
	function modeOf(event: MouseEvent | KeyboardEvent): SelectMode {
		if (event.shiftKey) return 'range';
		return event.metaKey || event.ctrlKey ? 'toggle' : 'single';
	}

	/** Bytes as a person reads them. Directories have no meaningful size here. */
	function humanSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = bytes / 1024;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit += 1;
		}
		return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
	}
</script>

<div class="pdmux pdmux-files" data-pdmux-files data-testid="file-explorer">
	{#if idle}
		<p class="pdmux-meta" data-pdmux-files-note>{tr('pdmux.files.pickHost', 'Choose a host to browse it')}</p>
	{:else if unavailable}
		<!--
			⚠ NOT AN ERROR, A FACT ABOUT THE HOST. An agent too old to browse, or an
			account with no home, has nothing to show — and saying "no files" would read
			as an empty home rather than as a host that cannot answer.
		-->
		<p class="pdmux-meta" data-pdmux-files-note>
			{tr('pdmux.files.unavailable', "This host's agent cannot browse files yet — update it to use this view")}
		</p>
	{:else}
		<div class="pdmux-files-body" data-pdmux-files-body>
			{#if dir?.error}
				<!-- The reason travels in the frame; a permission refusal is the OS
				     answering correctly, not a defect, so it is shown as it is. -->
				<p class="pdmux-meta" data-pdmux-files-error>{dir.error}</p>
			{:else if loading && !dir}
				<p class="pdmux-meta">{tr('pdmux.files.loading', 'Reading the directory…')}</p>
			{:else if dir && dir.entries.length === 0}
				<p class="pdmux-meta" data-pdmux-files-empty>{tr('pdmux.files.empty', 'This directory is empty')}</p>
			{:else if dir}
				<ul class="pdmux-files-list" data-pdmux-lines={dir.entries.length}>
					{#each dir.entries as entry (entry.name)}
						{@const kind = fileKindOf(entry.name, entry.dir)}
						<li>
							<button
								class="pdmux-files-row"
								type="button"
								data-pdmux-entry={entry.name}
								data-pdmux-kind={entry.dir ? 'dir' : 'file'}
								data-pdmux-file-kind={kind}
								data-pdmux-selected={chosen.has(entry.name) ? 'true' : undefined}
								aria-current={chosen.has(entry.name) ? 'true' : undefined}
								onclick={(event) =>
									entry.dir ? onOpenDir?.(join(entry.name)) : onSelect?.(entry.name, modeOf(event))}
							>
								<span class="pdmux-files-name">{entry.name}{entry.dir ? '/' : ''}</span>
								<!--
									⚠ A SYMLINK IS MARKED BECAUSE IT MAY REFUSE TO OPEN. The agent's
									root handle declines a link that leaves the home — and, measured,
									also one whose target is written as an absolute path even inside
									it. Saying so here turns that refusal into a property of the file
									instead of something that looks broken when it is clicked.
								-->
								{#if entry.symlink}
									<span class="pdmux-files-tag" data-pdmux-symlink>{tr('pdmux.files.symlink', 'link')}</span>
								{/if}
								<span class="pdmux-files-size">{entry.dir ? '' : humanSize(entry.size)}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if dir.dropped > 0}
					<p class="pdmux-meta" data-pdmux-files-dropped>
						{tr('pdmux.files.dropped', '{count} more entries are not listed').replace(
							'{count}',
							String(dir.dropped),
						)}
					</p>
				{/if}
			{/if}
		</div>

		{#if file || fileLoading || image}
			<!-- A face of its own: a header that says WHICH file, and a body that is the
			     only thing that scrolls (`ui-changes.md` §헤더와 본문을 나눈다). -->
			<section class="pdmux-files-preview" data-pdmux-files-preview>
				<div class="pdmux-files-preview-head">
					<span class="pdmux-files-preview-name" data-pdmux-preview-name
						>{(image?.path ?? file?.path ?? '').split('/').pop()}</span
					>
					<button
						class="pdmux-ico"
						type="button"
						data-testid="file-preview-close"
						title={tr('pdmux.files.close', 'Close')}
						aria-label={tr('pdmux.files.close', 'Close')}
						onclick={() => onClosePreview?.()}>✕</button
					>
				</div>
				<div class="pdmux-files-preview-body" data-pdmux-preview-kind={image ? 'image' : 'text'}>
					{#if image}
						<!--
							⚠ THE BROWSER FETCHES THIS, NOT US. A picture routed through the app
							would be held in memory to become a blob URL; an `img` streams,
							decodes and caches it without the page ever touching the bytes.
							`alt` is the file name because that is the only thing known about it.
						-->
						<img class="pdmux-files-image" src={image.url} alt={image.path.split('/').pop()} data-pdmux-preview-image />
					{:else}
						<BlobView blob={file} loading={fileLoading} {t} />
					{/if}
				</div>
			</section>
		{/if}
	{/if}
</div>
