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
	 *
	 * ⚠ THE COLUMN HEADER IS HERE AND NOT IN `apps/web`, WHICH LOOKS LIKE AN EXCEPTION
	 * AND IS NOT. A header cell has to line up with a body cell to the pixel, and the
	 * body cells are drawn here — split across two packages, the two would share a
	 * width constant and drift the first time somebody edited one of them. The line
	 * `ui-changes.md` draws is around CONTROLS (tabs, selects, dialogs), not around
	 * table geometry; the panel already owns a header of its own for the preview.
	 *
	 * ⚠ AND IT IS NOT `$lib/components/data-table.svelte`, WHICH `AGENTS.md` OTHERWISE
	 * REQUIRES OF EVERY LIST. That rule is about the shadcn admin console: the
	 * component is unreachable from here (`[TC-PDUI-030]` forbids this package from
	 * importing the app), it has no column resizing, and its pagination would break
	 * both the range-select and the `dropped` count below. What is copied instead is
	 * its VOCABULARY — `{ key, dir }`, the same toggle rule, `aria-sort`, a chevron
	 * pair — so the two tables in this product behave alike. `@pdmux/core`'s
	 * `nextFsSort` carries that rule.
	 *
	 * ⚠ SORTING HAPPENS BEFORE THE ENTRIES ARRIVE HERE. `dir.entries` is drawn in the
	 * order it is given, because the store that owns the listing also owns the
	 * selection — and its shift-click range is computed on ARRAY INDEX. A component
	 * that re-sorted for display would silently make range selection pick different
	 * files than the ones between the two the person clicked.
	 */
	import {
		DEFAULT_FS_SORT,
		FS_ROW_GAP,
		type FsColumnKey,
		type FsColumns,
		type FsSort,
		type FsSortKey,
		FS_COLUMN_DEFAULTS,
		fileKindOf,
		humanSize,
		isDefaultFsSort,
		modeLabel,
		UNKNOWN_VALUE,
		visibleFsColumns,
	} from '@pdmux/core';
	import type { FsDirView, FsFileView, SelectMode } from '../types.js';
	import { type Translate, translator } from '../i18n.js';
	import BlobView from './BlobView.svelte';
	import FileIcon from './FileIcon.svelte';
	import SplitHandle from './SplitHandle.svelte';

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
		/** Which column the listing is ordered by. The store applies it, not this. */
		sort?: FsSort;
		/** Widths of the number columns, in pixels. See `@pdmux/core`'s `fs-columns`. */
		columns?: FsColumns;
		/**
		 * The scheme the app is painted in, for the icons that have a light twin.
		 * The package cannot read it — see `FileIcon`.
		 */
		scheme?: 'light' | 'dark';
		/**
		 * How a modified time is written.
		 *
		 * ⚠ A PROP, NOT A FUNCTION IN THIS PACKAGE. `time.ts` states the rule: a
		 * package that formats a date owns a string its consumer cannot translate or
		 * localise. `GitGraph` takes the same prop with the same ISO fallback.
		 */
		formatDate?: (epochSeconds: number) => string;
		t?: Translate;
		onOpenDir?: (path: string) => void;
		/** A click on a row. Directories navigate; files select and preview. */
		onSelect?: (name: string, mode: SelectMode) => void;
		onClosePreview?: () => void;
		/** A click on a column header. Reports the KEY; the store decides the direction. */
		onSort?: (key: FsSortKey) => void;
		/**
		 * A dragged column edge.
		 *
		 * ⚠ `delta` IS MEASURED FROM WHERE THE GESTURE STARTED, so the caller adds it to
		 * the width the gesture started from — adding it to the current width compounds
		 * every pointer move into a runaway column. `commit` is true once, on release.
		 *
		 * `panelWidth` travels with it because this component is what measures the
		 * listing, and the caller's clamp needs it to keep the name column from being
		 * squeezed out in a narrow dock.
		 */
		onColumnResize?: (key: FsColumnKey, delta: number, commit: boolean, panelWidth: number) => void;
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
		sort = DEFAULT_FS_SORT,
		columns = FS_COLUMN_DEFAULTS,
		scheme = 'light',
		formatDate,
		t,
		onOpenDir,
		onSelect,
		onClosePreview,
		onSort,
		onColumnResize,
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

	/**
	 * How wide the listing actually is.
	 *
	 * ⚠ MEASURED, NOT A MEDIA QUERY. One viewport holds a 420px dock and a full-width
	 * window at the same time, so a breakpoint answers the wrong question — the same
	 * reason `FileList` observes its own box. The BODY is measured rather than the
	 * panel because its scrollbar is not room the columns may spend.
	 */
	let bodyEl = $state<HTMLDivElement | null>(null);
	let bodyWidth = $state(0);

	$effect(() => {
		const node = bodyEl;
		if (!node || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => (bodyWidth = node.clientWidth));
		observer.observe(node);
		bodyWidth = node.clientWidth;
		return () => observer.disconnect();
	});

	const visible = $derived(visibleFsColumns(bodyWidth, columns));
	const shows = (key: FsColumnKey): boolean => visible.includes(key);

	/** `0` means the host did not say — never a date in 1970. */
	const dateOf = (seconds: number): string => {
		if (!seconds) return UNKNOWN_VALUE;
		if (formatDate) return formatDate(seconds);
		return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
	};

	const COLUMN_LABELS: Readonly<Record<FsSortKey, [key: string, fallback: string]>> = {
		name: ['pdmux.files.colName', 'Name'],
		size: ['pdmux.files.colSize', 'Size'],
		modified: ['pdmux.files.colModified', 'Modified'],
		mode: ['pdmux.files.colMode', 'Mode'],
	};

	const headerLabel = (key: FsSortKey): string => {
		const [id, fallback] = COLUMN_LABELS[key];
		return tr(id, fallback);
	};

	/**
	 * The ordering, said out loud.
	 *
	 * ⚠ NOT `aria-sort`, AND THE LINTER IS RIGHT ABOUT WHY. That attribute belongs to
	 * `columnheader`, which belongs inside a table or a grid — and the listing below is
	 * deliberately a LIST OF BUTTONS, one activatable thing per file, which is what a
	 * file browser actually is. Wrapping it in table roles to license one attribute
	 * would describe the panel as something it is not, and a screen reader would then
	 * announce cells that do not exist. `DataTable` uses `aria-sort` correctly because
	 * it renders a real `<table>`.
	 *
	 * So the state goes into the control's own name, which every reader announces, and
	 * `data-pdmux-sort` carries it for the stylesheet and for the specs.
	 */
	const sortLabel = (key: FsSortKey): string => {
		const column = headerLabel(key);
		if (sort.key !== key) return tr('pdmux.files.sortBy', 'Sort by {column}').replace('{column}', column);
		const id = sort.dir === 'asc' ? 'pdmux.files.sortedAscending' : 'pdmux.files.sortedDescending';
		const fallback = sort.dir === 'asc' ? '{column}, sorted ascending' : '{column}, sorted descending';
		return tr(id, fallback).replace('{column}', column);
	};
</script>

<!--
	⚠ THE WIDTHS TRAVEL AS CUSTOM PROPERTIES SO HEADER AND BODY READ ONE NUMBER. Two
	declarations for one column is how a header stops lining up with its cells, and
	`ui-changes.md` records what a duplicated width constant costs. `--pdmux-files-gap`
	comes from `@pdmux/core` for the same reason: the reducer that decides which
	columns fit has to spend the same gap the stylesheet does.
-->
<div
	class="pdmux pdmux-files"
	data-pdmux-files
	data-testid="file-explorer"
	style="--pdmux-files-gap:{FS_ROW_GAP}px; --pdmux-files-w-size:{columns.size}px; --pdmux-files-w-modified:{columns.modified}px; --pdmux-files-w-mode:{columns.mode}px"
>
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
		<div class="pdmux-files-body" data-pdmux-files-body bind:this={bodyEl}>
			{#if dir?.error}
				<!-- The reason travels in the frame; a permission refusal is the OS
				     answering correctly, not a defect, so it is shown as it is. -->
				<p class="pdmux-meta" data-pdmux-files-error>{dir.error}</p>
			{:else if loading && !dir}
				<p class="pdmux-meta">{tr('pdmux.files.loading', 'Reading the directory…')}</p>
			{:else if dir && dir.entries.length === 0}
				<p class="pdmux-meta" data-pdmux-files-empty>{tr('pdmux.files.empty', 'This directory is empty')}</p>
			{:else if dir}
				<!--
					⚠ THE HEADER EXISTS ONLY WHEN THERE ARE ROWS. The four states above are
					what `[TC-PDUI-219]` locks — a host that cannot browse, a directory
					being read, one that is empty, one with entries — and a column header
					floating over "this directory is empty" says the panel is a table that
					failed rather than a directory with nothing in it.

					⚠ AND IT LIVES INSIDE THE SCROLL BOX, STUCK TO ITS TOP. Outside it, the
					header would be as wide as the panel while the rows are as wide as the
					panel MINUS the scrollbar — 15px on this Mac's Chrome, measured — and
					every column would sit a scrollbar to the right of its cells.
				-->
				<div class="pdmux-files-head" data-pdmux-files-head>
					<span class="pdmux-files-head-icon" aria-hidden="true"></span>
					<div class="pdmux-files-cell pdmux-files-cell-name">
						<button
							class="pdmux-files-col"
							type="button"
							data-pdmux-col="name"
							data-pdmux-sort={sort.key === 'name' ? sort.dir : undefined}
							aria-label={sortLabel('name')}
							onclick={() => onSort?.('name')}
						>
							<span class="pdmux-files-col-label">{headerLabel('name')}</span>
							{@render arrow('name')}
						</button>
					</div>
					{#each visible as key (key)}
						<div class="pdmux-files-cell" data-pdmux-cell={key}>
							<!--
								⚠ THE GRIP IS ABSOLUTE, AND IT IS NOT INSIDE THE BUTTON. Absolute
								so it costs no layout width — a grip that took a flex slot would
								push every header cell out of line with its column. Outside the
								button because a `pointerdown` on a child of a control is also a
								click on that control, so dragging an edge would re-sort the list.

								⚠ `invert` BECAUSE THE GRIP IS ON THE COLUMN'S LEADING EDGE. Dragging
								that boundary LEFT makes the column wider, which is against the axis
								direction — the same negation a right-hand dock needs. Without it the
								column shrank when it should have grown: measured as -40px where +40px
								was expected, by the geometry spec rather than by anybody looking.
							-->
							<SplitHandle
								{t}
								invert
								label={tr('pdmux.files.resizeColumn', 'Resize column')}
								onDrag={(delta) => onColumnResize?.(key, delta, false, bodyWidth)}
								onCommit={(delta) => onColumnResize?.(key, delta, true, bodyWidth)}
							/>
							<button
								class="pdmux-files-col"
								type="button"
								data-pdmux-col={key}
								data-pdmux-sort={sort.key === key ? sort.dir : undefined}
								aria-label={sortLabel(key)}
								onclick={() => onSort?.(key)}
							>
								<span class="pdmux-files-col-label">{headerLabel(key)}</span>
								{@render arrow(key)}
							</button>
						</div>
					{/each}
				</div>
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
								<FileIcon name={entry.name} dir={entry.dir} {scheme} />
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
								{#if shows('modified')}
									<span class="pdmux-files-modified">{dateOf(entry.modified)}</span>
								{/if}
								{#if shows('mode')}
									<span class="pdmux-files-mode">{modeLabel(entry.mode)}</span>
								{/if}
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
						<!--
							⚠ THE HOST SORTED AND THEN TRUNCATED, IN THAT ORDER. So what arrived is
							the first N in NAME order, and a click on `size` orders that slice rather
							than the directory — the largest file on the host may not be in the array
							at all. Saying so is the difference between a listing and a wrong answer.
						-->
						{#if !isDefaultFsSort(sort)}
							<span data-pdmux-files-sorted-subset>
								{tr(
									'pdmux.files.sortedSubset',
									'Sorted within the entries listed, not the whole directory',
								)}
							</span>
						{/if}
					</p>
				{/if}
			{/if}
		</div>

		{#if file || fileLoading || image}
			<!-- A face of its own: a header that says WHICH file, and a body that is
			     the only thing that scrolls. A title that scrolls away mid-file leaves
			     the reader with no way back to "which file is this". -->
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

<!--
	The sort arrow. Path data is lucide's `chevron-up` / `chevron-down` /
	`chevrons-up-down` (ISC, © Lucide Icons and Contributors), copied rather than
	imported for the reason `HostCard` records: this package ships one peer
	dependency and an icon library is not worth breaking that for.

	⚠ THE INACTIVE COLUMNS KEEP AN ARROW TOO, DIMMED. Drawing one only on the active
	column leaves the others looking like labels, and a person cannot tell that
	clicking them does anything — the same affordance `DataTable` gives.
-->
{#snippet arrow(key: FsSortKey)}
	<svg
		class="pdmux-files-arrow"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		data-pdmux-arrow={sort.key === key ? sort.dir : 'none'}
	>
		{#if sort.key !== key}
			<path d="m7 15 5 5 5-5" />
			<path d="m7 9 5-5 5 5" />
		{:else if sort.dir === 'asc'}
			<path d="m18 15-6-6-6 6" />
		{:else}
			<path d="m6 9 6 6 6-6" />
		{/if}
	</svg>
{/snippet}
