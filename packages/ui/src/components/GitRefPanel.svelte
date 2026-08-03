<script lang="ts">
	/**
	 * The repository's own state, beside the graph: where HEAD is, and every branch
	 * and tag with its divergence.
	 *
	 * WHY IT IS A PANEL AND NOT ROW DECORATION: the graph answers "what happened",
	 * this answers "where am I and what is behind" — the question people actually open
	 * a graph for. The row chips cannot answer it, because a branch that has diverged
	 * or lost its upstream may be nowhere near the visible rows.
	 *
	 * ⚠ IT SCROLLS ITSELF (`min-height:0; overflow:auto`). A repository with hundreds
	 * of tags must not lengthen the page — the graph and the detail panel own the rest
	 * of the viewport, and a document scrollbar is the layout bug this project measures
	 * for.
	 *
	 * ⚠ REMOTE ROWS ARE AS OLD AS THE LAST FETCH, because the collector never fetches
	 * (that would write to somebody's checkout). The panel says so rather than letting
	 * a stale `↓3` look live.
	 */
	import { type RefInput, type RefKind, groupRefs } from '@pdmux/core';
	import { type Translate, translator } from '../i18n.js';
	import type { RepoHead } from '../types.js';

	interface Props {
		head?: RepoHead | null;
		refs?: readonly RefInput[];
		t?: Translate;
		/**
		 * Has an answer arrived? `false` means "not asked yet", and the difference is the
		 * whole point: an empty list rendered before the response says "there is nothing
		 * here" about something nobody has looked at. On a wide dock that reads as a
		 * blank column with a verdict in it, on every refresh. Defaults to `true` so a
		 * caller that renders from data it already holds is unaffected.
		 */
		ready?: boolean;
	}

	let { head = null, refs = [], t, ready = true }: Props = $props();

	const tr = $derived(translator(t));
	const groups = $derived(groupRefs(refs));
	const sections = $derived(
		(
			[
				['local', tr('pdmux.refs.local', 'Local branches')],
				['remote', tr('pdmux.refs.remote', 'Remote branches')],
				['tag', tr('pdmux.refs.tags', 'Tags')],
			] as [RefKind, string][]
		)
			.map(([kind, title]) => ({ kind, title, rows: groups[kind] }))
			.filter((section) => section.rows.length > 0),
	);

	const short = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);

	/** `↑2 ↓1`, plus `gone` — the marks that mean "this needs attention". */
	function marksOf(ref: { ahead?: number | null; behind?: number | null }): string {
		const marks: string[] = [];
		if (ref.ahead) marks.push(`↑${ref.ahead}`);
		if (ref.behind) marks.push(`↓${ref.behind}`);
		return marks.join(' ');
	}

	const headLabel = $derived.by(() => {
		if (!head) return '';
		if (head.detached) return `${tr('pdmux.refs.detached', 'detached')} @ ${short(head.sha)}`;
		return head.branch ?? tr('pdmux.refs.unknownHead', 'unknown');
	});

	/** Upstream state of HEAD: how far apart, or in sync, or the upstream is gone. */
	const headTracking = $derived.by(() => {
		if (!head?.upstream) return '';
		if (head.gone) return tr('pdmux.refs.gone', 'upstream gone');
		return marksOf(head) || tr('pdmux.refs.inSync', 'in sync');
	});
</script>

<aside
	class="pdmux pdmux-refs"
	data-pdmux-refs
	aria-label={tr('pdmux.refs.label', 'repository state')}
	tabindex="-1"
>
	{#if head}
		<div class="pdmux-refs-head">
			<div class="pdmux-refs-branch" data-pdmux-head-state data-detached={head.detached ? 'true' : 'false'}>
				{headLabel}
			</div>
			{#if head.upstream}
				<div class="pdmux-refs-up" data-pdmux-head-upstream data-gone={head.gone ? 'true' : 'false'}>
					<span class="pdmux-refs-up-name">{head.upstream}</span>
					<span class="pdmux-refs-up-state">{headTracking}</span>
				</div>
			{/if}
			{#if head.path}<div class="pdmux-refs-path" title={head.path}>{head.path}</div>{/if}
		</div>
	{/if}

	{#each sections as section (section.kind)}
		<h3 class="pdmux-refs-title" data-pdmux-refs-group={section.kind}>
			{section.title} ({section.rows.length})
		</h3>
		<ul class="pdmux-refs-list">
			{#each section.rows as ref (ref.name)}
				{@const marks = marksOf(ref)}
				<li class="pdmux-ref" data-pdmux-ref={ref.name} data-kind={section.kind}>
					<span class="pdmux-ref-name">{ref.name}</span>
					{#if ref.gone}
						<!-- The reason someone opens this panel: the branch still exists here,
						     its upstream does not. A count cannot say that. -->
						<span class="pdmux-ref-gone" data-pdmux-gone>{tr('pdmux.refs.gone', 'upstream gone')}</span>
					{/if}
					{#if marks}<span class="pdmux-ref-div">{marks}</span>{/if}
					<span class="pdmux-ref-sha">{short(ref.sha)}</span>
				</li>
			{/each}
		</ul>
		{#if section.kind === 'remote'}
			<p class="pdmux-refs-note">{tr('pdmux.refs.fetchNote', 'Remote refs are as of the last fetch')}</p>
		{/if}
	{/each}

	{#if !sections.length && ready}
		<!-- Only once there IS an answer — see `ready`. -->
		<p class="pdmux-meta" data-pdmux-empty="refs">{tr('pdmux.refs.empty', 'No branches or tags')}</p>
	{/if}
</aside>
