<script lang="ts">
  /**
   * The read-only commit column: pick a repository, read its graph, click a row to
   * see what changed.
   *
   * It is one component because the dashboard's right-hand dock and the detached
   * `/git/...` window must be the SAME view — a detached window that drifts from the
   * docked one is two features to maintain and two ways to be wrong.
   */
  import { onDestroy } from "svelte";
  import { CommitDetail, GitGraph, GitRefPanel, SplitHandle, type Translate } from "@pdmux/ui";
  import { UNCOMMITTED } from "@pdmux/core";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { SHELL_STACK_MAX_WIDTH } from "@pdmux/core";
  import { IsMobile } from "$lib/hooks/is-mobile.svelte";
  import { fmt, getI18n } from "$lib/i18n";
  import type { GitDock } from "../git-dock.svelte";
  import { dockEmptyReason } from "../git-roots";
  import { graphCommits, refInputs, repoHead, uncommittedFor, workingDiffFiles } from "../map";
  import type { HostView } from "../types";

  let {
    dock,
    hosts = [],
    t,
    refsOpen = false,
    detailHeight = null,
    onHostChange,
    onRepoChange,
    onToggleRefs,
    onDetach,
    onDetailResize,
  }: {
    dock: GitDock;
    hosts?: readonly HostView[];
    t?: Translate;
    /**
     * Whether the refs panel shares the column. On by default — a panel that needs a
     * switch found first is a panel the person who asked for it keeps reporting as
     * missing. Hiding it is the deliberate act, and the caller owns that choice and its
     * persistence; below ~260px of column the stylesheet drops it regardless, because
     * the graph cannot be squeezed into what is left.
     */
    refsOpen?: boolean;
    /** Height of the detail panel in px, or null for content height. */
    detailHeight?: number | null;
    onHostChange?: (hostId: string) => void;
    /**
     * A drag on the detail's edge, reported as a signed delta from where the gesture
     * started (`commit` on release). The caller owns the base height and its
     * persistence — the same division as the sidebar and dock splitters.
     */
    onDetailResize?: (delta: number, commit: boolean) => void;
    onRepoChange?: (repoId: string) => void;
    onToggleRefs?: () => void;
    onDetach?: () => void;
  } = $props();

  const i18n = getI18n();
  const commits = $derived(graphCommits(dock.graph?.commits ?? []));
  const refs = $derived(refInputs(dock.graph?.refs ?? []));
  const repo = $derived(dock.repo);
  const uncommitted = $derived(uncommittedFor(repo, dock.working));
  const head = $derived(repoHead(repo, dock.graph?.refs ?? []));
  /**
   * Is there an answer for the selected repository yet? `dock.graph` is null until its
   * response lands, and the graph and refs panels must not report "No commits" / "No
   * branches or tags" about a repository they have not heard back on.
   */
  const graphReady = $derived(dock.graph !== null || dock.error !== null);
  const selectedHost = $derived(hosts.find((host) => host.id === dock.hostId));
  const hostName = $derived(selectedHost?.label ?? i18n.t.dash.git.noHost);
  /**
   * ⚠ ONE SENTENCE USED TO COVER THREE SITUATIONS and it was only true for one of
   * them. `git.noRepos` reads as "wait a moment" — so a host
   * nobody ever gave a path to, and a host without git installed, both looked
   * like a host still working on it, for ever. The count is the server's
   * effective one (own rows, else the fleet list); the dock never sees the fleet
   * settings and could not work it out here.
   */
  const emptyReason = $derived(
    dockEmptyReason(selectedHost?.gitRootCount ?? 0, selectedHost?.diagnostics ?? []),
  );
  const repoName = $derived(repo?.name ?? i18n.t.dash.git.repo);

  const uncommittedLabel = $derived.by(() => {
    if (!repo) return "";
    const parts = [fmt(i18n.t.dash.git.uncommittedRow, { count: uncommitted?.total ?? repo.dirtyCount })];
    if (repo.dirtySubmodules > 0) {
      parts.push(fmt(i18n.t.dash.git.submodules, { count: repo.dirtySubmodules }));
    }
    return parts.join(" · ");
  });

  /**
   * The working-tree row reuses the commit panel rather than a second one: the panel
   * already keeps itself inside the viewport, and "what changed" reads the same way
   * whether or not it has been committed.
   */
  const selectedCommit = $derived.by(() => {
    if (!dock.selected) return null;
    if (dock.selected === UNCOMMITTED) {
      return { sha: UNCOMMITTED, subject: i18n.t.dash.git.workingTree, author: "", date: null };
    }
    const row = dock.graph?.commits.find((commit) => commit.sha === dock.selected);
    if (!row) return null;
    const parsed = row.date ? Date.parse(row.date) : Number.NaN;
    return {
      sha: row.sha,
      subject: row.subject,
      author: row.author,
      date: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
    };
  });

  const detail = $derived.by(() => {
    if (dock.selected === UNCOMMITTED) {
      return dock.working ? { files: workingDiffFiles(dock.working), dropped: dock.working.dropped } : null;
    }
    return dock.detail;
  });

  /**
   * A graph row gets one short line, not a full locale timestamp.
   *
   * The dock is a narrow column and a full "7/25/2026, 7:01:51 PM" wraps onto a
   * second line, which pushes the sha out of its own column — measured at the
   * default 420px width.
   */
  const rowDate = new Intl.DateTimeFormat(i18n.locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  /**
   * A phone gets the DATE ONLY.
   *
   * Narrowing the column was not enough: `07/26, 10:18 AM` simply wrapped inside a
   * fixed-height row and covered the commit underneath it (reported). The stylesheet now
   * clips as a guarantee, but a clipped timestamp is not information — and the exact minute
   * is one tap away in the detail panel, while the subject is what a person is reading.
   */
  const narrow = new IsMobile(SHELL_STACK_MAX_WIDTH);
  const rowDateShort = new Intl.DateTimeFormat(i18n.locale, { month: "2-digit", day: "2-digit" });
  const formatDate = (epochSeconds: number): string =>
    (narrow.current ? rowDateShort : rowDate).format(new Date(epochSeconds * 1000));
  /** The detail panel has the room for a full timestamp, and wants the seconds. */
  const formatDetailDate = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toLocaleString(i18n.locale);

  /**
   * The dock's state outlives this component — the shell keeps one instance so
   * returning from `/hosts` finds the same repository and the same open commit. A poll
   * waiting for a patch must NOT outlive it, though: that is a timer firing HTTP
   * requests for a panel nobody can see.
   */
  onDestroy(() => dock.suspend());
</script>

<div class="pdmux pdmux-graph" data-pdmux-region="dock" data-testid="commit-dock">
  <header class="flex items-center gap-2 border-b px-2 py-1.5 text-xs">
    {#if hosts.length}
      <Select.Root
        type="single"
        value={dock.hostId ?? ""}
        onValueChange={(value: string) => onHostChange?.(value)}
      >
        <Select.Trigger class="h-7 w-28 text-xs" data-testid="dock-host">{hostName}</Select.Trigger>
        <Select.Content>
          {#each hosts as host (host.id)}
            <Select.Item value={host.id}>{host.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
    <Select.Root
      type="single"
      value={dock.repoId ?? ""}
      onValueChange={(value: string) => onRepoChange?.(value)}
    >
      <Select.Trigger class="h-7 flex-1 text-xs" data-testid="dock-repo">{repoName}</Select.Trigger>
      <Select.Content>
        {#each dock.repos as row (row.id)}
          <Select.Item value={row.id}>{row.name}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if onToggleRefs}
      <Button
        variant={refsOpen ? "default" : "outline"}
        size="sm"
        class="h-7 px-2"
        title={i18n.t.dash.git.refs}
        aria-label={i18n.t.dash.git.refs}
        data-testid="dock-refs"
        aria-pressed={refsOpen}
        onclick={() => onToggleRefs?.()}>⑂</Button
      >
    {/if}
    {#if onDetach}
      <Button
        variant="ghost"
        size="sm"
        class="h-7 px-2"
        title={i18n.t.dash.git.detach}
        aria-label={i18n.t.dash.git.detach}
        data-testid="dock-detach"
        onclick={() => onDetach?.()}>↗</Button
      >
    {/if}
  </header>

  {#if dock.error}
    <p class="text-destructive px-2 py-1 text-xs" data-testid="dock-error">{i18n.t.dash.git.loadFailed}</p>
  {:else if dock.hostId && dock.reposLoaded && !dock.repos.length}
    <!-- Three conditions, all load-bearing: a host must be chosen (otherwise the message
         is about nothing), the list must have come back (otherwise it is a guess), and it
         must be empty. Announcing an empty result before asking is what made the dock
         say "no repositories" for ~600ms after every refresh. -->
    <div class="text-muted-foreground px-2 py-1 text-xs" data-testid="dock-empty">
      {#if emptyReason === "no-git"}
        <!-- Nothing about paths here: a missing binary is not fixed on the
             settings screen, and sending somebody there wastes the trip. -->
        <p>{i18n.t.dash.git.noGit}</p>
      {:else if emptyReason === "no-roots"}
        <p>{i18n.t.dash.git.noRoots}</p>
        <a class="underline underline-offset-2" href={`/hosts/${dock.hostId}`} data-testid="dock-empty-action">
          {i18n.t.dash.git.noRootsAction}
        </a>
      {:else}
        <p>{i18n.t.dash.git.noRepos}</p>
      {/if}
    </div>
  {/if}
  {#if repo?.error}
    <p class="text-destructive px-2 py-1 text-xs">{fmt(i18n.t.dash.git.error, { message: repo.error })}</p>
  {/if}

  <!-- Refs panel │ graph: a row, so each side scrolls itself (ARCHITECTURE §7). -->
  <div class="pdmux pdmux-graph-body">
    {#if refsOpen}
      <GitRefPanel {head} {refs} {t} ready={graphReady} />
    {/if}
    <GitGraph
      ready={graphReady}
      {commits}
      {refs}
      {uncommitted}
      {uncommittedLabel}
      head={repo?.headSha ?? null}
      selectedSha={dock.selected}
      {formatDate}
      {t}
      onSelect={(sha) => void dock.select(sha)}
    />
  </div>
  <!-- The handle only exists while the panel does: a row splitter under an empty graph
       would resize something the user cannot see. `invert` because it sits ABOVE the
       panel, so dragging up must make it taller. -->
  {#if selectedCommit && onDetailResize}
    <SplitHandle
      axis="y"
      invert
      {t}
      onDrag={(delta: number) => onDetailResize?.(delta, false)}
      onCommit={(delta: number) => onDetailResize?.(delta, true)}
    />
  {/if}
  <CommitDetail
    commit={selectedCommit}
    {detail}
    pending={dock.pending}
    loading={dock.loading}
    onRetry={() => void dock.retryDetail()}
    formatDate={formatDetailDate}
    height={detailHeight}
    {t}
  />
</div>
