<script lang="ts">
	/**
	 * A parsed patch: one box per file, coloured by the leading character.
	 *
	 * Every line is rendered as text, never as markup — a patch is untrusted content
	 * that comes from somebody's repository.
	 */
	import { type DiffLineKind, diffFileTitle, diffLineKind } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';

	interface DiffFileInput {
		path: string;
		oldPath?: string | null;
		status?: 'A' | 'M' | 'D' | 'R';
		add?: number;
		del?: number;
		binary?: boolean;
		truncated?: boolean;
		lines?: readonly string[];
	}

	interface Props {
		files?: readonly DiffFileInput[];
		/** Shown after the list, e.g. "3 files omitted by the size cap". */
		note?: string;
		t?: Translate;
	}

	let { files = [], note = '', t }: Props = $props();

	const tr = $derived(translator(t));
	const statusLabels: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', '?': '' };
	const kindOf = (line: string): DiffLineKind => diffLineKind(line);
</script>

{#if files.length}
	<div data-pdmux-diffs>
		{#each files as file (file.path)}
			{@const title = diffFileTitle(file)}
			<div class="pdmux-diff" data-pdmux-file={title.path}>
				<div class="pdmux-diff-head">
					{tr(`pdmux.diff.status.${title.status}`, statusLabels[title.status] ?? title.status)}
					{title.oldPath ? `${title.oldPath} → ${title.path}` : title.path}
					{title.binary ? tr('pdmux.diff.binary', 'binary') : `+${title.add} -${title.del}`}{title.truncated
						? ` (${tr('pdmux.diff.partial', 'partial')})`
						: ''}
				</div>
				{#if title.binary}
					<p class="pdmux-meta">{tr('pdmux.diff.binaryBody', 'Binary file — contents are not shown')}</p>
				{:else}
					<pre class="pdmux-patch">{#each file.lines ?? [] as line, i (i)}<span data-kind={kindOf(line)}
								>{line}</span
							>{/each}</pre>
				{/if}
			</div>
		{/each}
		{#if note}<p class="pdmux-meta">{note}</p>{/if}
	</div>
{:else}
	<p class="pdmux-meta" data-pdmux-empty="diff">{note || tr('pdmux.diff.empty', 'No changes')}</p>
{/if}
