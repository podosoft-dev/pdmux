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
  import { UNCOMMITTED, feedAge, remoteComparison } from "@pdmux/core";
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button } from "$lib/components/ui/button";
  import { SHELL_STACK_MAX_WIDTH } from "@pdmux/core";
  import { IsMobile } from "$lib/hooks/is-mobile.svelte";
  import { toast } from "svelte-sonner";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import ArrowDownUpIcon from "@lucide/svelte/icons/arrow-down-up";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import FolderTreeIcon from "@lucide/svelte/icons/folder-tree";
  import ListIcon from "@lucide/svelte/icons/list";
  import UnfoldVerticalIcon from "@lucide/svelte/icons/unfold-vertical";
  import { fmt, getI18n } from "$lib/i18n";
  import { gitApi } from "../api";
  import { causeMessage } from "../wording";
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

  /**
   * When this snapshot was taken, and whether that is recent enough to trust.
   *
   * ⚠ THE ANSWER "NEVER" IS A DIFFERENT ANSWER FROM "A WHILE AGO", and both are
   * different from a number. A repo the agent has not reported on yet has no time
   * at all, and rendering that as 0 would read as "just now" — the most misleading
   * possible value for the one thing this line exists to tell.
   */
  let busy = $state<"repos" | "remote" | null>(null);

  /**
   * Which face of the commit detail is showing.
   *
   * ⚠ THE CONTROL LIVES HERE, NOT IN `@pdmux/ui`. That package cannot import shadcn
   * (`[TC-PDUI-030]` keeps it installable by a project with its own design system),
   * so a tab strip built there is a lookalike — and a hand-rolled one under a
   * product built entirely from shadcn is exactly what it looks like. The app owns
   * the tabs; the package owns the two panels.
   *
   * It opens on the changes because that is what the click was for, and it resets
   * with the commit.
   */
  let detailView = $state<"commit" | "changes">("changes");
  /**
   * How the file list is grouped, and whether every patch is open.
   *
   * ⚠ THESE ARE VIEW MODES ON THE LIST, NOT TABS — that is the correction. Fork puts
   * tree-versus-list behind one button in the file list's corner and "Expand All"
   * beside it; shipping "File tree" as a third tab put the same files in two places
   * and let neither of them be clicked.
   *
   * They persist across commits deliberately: unlike the chosen FILE, "I read trees"
   * is a preference about the person, not about the commit.
   */
  let fileView = $state<"tree" | "list">("tree");
  let expandAll = $state(false);
  /** Which file's patch is open. Belongs to the commit, so it resets with it. */
  let selectedPath = $state<string | null>(null);
  $effect(() => {
    dock.selected;
    detailView = "changes";
    selectedPath = null;
  });
  // `feedAge` rather than a local subtraction: it already buckets on raw milliseconds
  // (rounding first made a 30-second-old snapshot claim to be a minute behind) and it
  // already decides that an unknown timestamp is a warning rather than a zero.
  const age = $derived(
    feedAge(repo?.lastSnapshotAt ? Date.parse(repo.lastSnapshotAt) / 1000 : null, Date.now()),
  );
  const freshText = $derived.by(() => {
    if (busy) return i18n.t.dash.git.collecting;
    if (!age.known) return i18n.t.dash.git.neverCollected;
    const ago =
      age.unit === "now"
        ? i18n.t.dash.git.agoNow
        : fmt(age.unit === "minute" ? i18n.t.dash.git.agoMinutes : i18n.t.dash.git.agoHours, {
            count: age.value,
          });
    return age.stale ? `⚠ ${ago}` : ago;
  });
  const freshTitle = $derived(repo?.lastSnapshotAt ?? i18n.t.dash.git.neverCollected);

  /**
   * ⚠ NO DISTANCE IS PASSED IN, so every row that moved says so without a number.
   * `ls-remote` downloads no objects, so the sha it reports is usually a commit this
   * checkout has never seen — nothing here could count towards it, and "3 behind"
   * would be invented. `remoteComparison` keeps that rule; this only draws it.
   */
  const remoteRows = $derived(
    remoteComparison(
      (dock.graph?.refs ?? []).map((ref) => ({ name: ref.name, sha: ref.sha, kind: ref.kind })),
      repo?.remoteRefs ?? [],
    ),
  );
  function remoteLabel(status: string): string {
    if (status === "moved") return i18n.t.dash.git.remoteMoved;
    if (status === "appeared") return i18n.t.dash.git.remoteAppeared;
    if (status === "gone") return i18n.t.dash.git.remoteGone;
    return i18n.t.dash.git.remoteSame;
  }

  /**
   * Ask the agent for a pass now.
   *
   * The answer arrives as a snapshot on the host feed rather than as this call's
   * response, so the button reports "collecting" until the repo's timestamp moves
   * rather than pretending to be done when the request was merely accepted.
   */
  async function collect(what: "repos" | "remote"): Promise<void> {
    if (!dock.hostId || busy) return;
    busy = what;
    try {
      await gitApi.collect(dock.hostId, what);
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    } finally {
      // A fixed window rather than polling: the feed pushes the new snapshot, and a
      // button that spun until it arrived would spin forever on an offline host.
      setTimeout(() => (busy = null), 2_000);
    }
  }
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
    <!-- ⚠ WHEN THIS WAS COLLECTED, SAID OUT LOUD. The graph is a snapshot an agent
         took on a timer, and ARCHITECTURE §4 claimed for a long time that "the UI
         says so" while no such line existed anywhere. Without it there is no way to
         tell a quiet repository from a dead agent. -->
    <span class="text-muted-foreground shrink-0" data-testid="dock-freshness" title={freshTitle}>
      {freshText}
    </span>
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={busy !== null}
      title={i18n.t.dash.git.rescan}
      aria-label={i18n.t.dash.git.rescan}
      data-testid="dock-rescan"
      onclick={() => collect("repos")}><RefreshCwIcon class="size-4" /></Button
    >
    <!-- The only control here that reaches a network. It runs `ls-remote`, which
         reads the remote's refs and writes nothing to the checkout — pdmux never
         fetches, and the panel says so where the answer appears. -->
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={busy !== null}
      title={i18n.t.dash.git.checkRemote}
      aria-label={i18n.t.dash.git.checkRemote}
      data-testid="dock-remote"
      onclick={() => collect("remote")}><ArrowDownUpIcon class="size-4" /></Button
    >
    {#if onToggleRefs}
      <Button
        variant={refsOpen ? "default" : "outline"}
        size="sm"
        class="h-7 px-2"
        title={i18n.t.dash.git.refs}
        aria-label={i18n.t.dash.git.refs}
        data-testid="dock-refs"
        aria-pressed={refsOpen}
        onclick={() => onToggleRefs?.()}><GitBranchIcon class="size-4" /></Button
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
        onclick={() => onDetach?.()}><ExternalLinkIcon class="size-4" /></Button
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
      <!-- ⚠ ONE FLEX CHILD, NOT TWO. `.pdmux-graph-body` lays its children out in a
           ROW, so a panel added beside the refs took a column of its own and the
           commit list was squeezed to zero width — measured at 1600px: refs 150px,
           this 270px, graph 0px. The refs column and the remote report belong to the
           same column, so they share one. -->
      <div class="pdmux pdmux-refs-column">
        <GitRefPanel {head} {refs} {t} ready={graphReady} />
        <!-- ⚠ A SEPARATE SECTION FROM THE REFS ABOVE, and the separation is the point.
             Those are local pointers — including `origin/*`, which is a remote-TRACKING
             ref and therefore as old as the last fetch somebody ran by hand. This is
             what the remote itself answered. -->
        <div class="shrink-0 border-t px-2 py-1.5 text-xs" data-testid="dock-remote-panel">
        <p class="text-muted-foreground font-medium">{i18n.t.dash.git.remoteTitle}</p>
        {#if repo?.remoteError}
          <p class="text-destructive" data-testid="dock-remote-error">
            {i18n.t.dash.git.remoteFailed} — {repo.remoteError}
          </p>
        {:else if !repo?.remoteCheckedAt}
          <p class="text-muted-foreground" data-testid="dock-remote-never">{i18n.t.dash.git.remoteNever}</p>
        {:else}
          {#each remoteRows as row (row.name)}
            <div class="flex items-baseline justify-between gap-2" data-testid="dock-remote-row" data-status={row.status}>
              <span class="truncate">{row.name}</span>
              <span class="text-muted-foreground shrink-0">
                {#if row.behind !== null}
                  {fmt(i18n.t.dash.git.remoteBehind, { count: row.behind })}
                {:else}
                  {remoteLabel(row.status)}
                {/if}
              </span>
            </div>
          {/each}
          <!-- Said where the answer is, not in a tooltip: "we cannot show you the
               commits" is the first question this panel raises. -->
            <p class="text-muted-foreground mt-1">{i18n.t.dash.git.remoteNote}</p>
          {/if}
        </div>
      </div>
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
  {#if selectedCommit}
    <!-- Real shadcn `Tabs`, in the app that owns the design system, and with the
         DEFAULT look. Overriding the list into an underline bar is what made these
         read as hand-rolled — the two other tab strips in this app
         (`host-install-dialog`, `host-agent-access`) pass no classes at all, and that
         is the product's tab. -->
    <div class="flex shrink-0 items-center justify-between gap-2 px-1 pb-1">
      <Tabs.Root bind:value={detailView} class="min-h-0 gap-0">
        <Tabs.List>
          <Tabs.Trigger value="commit" data-testid="detail-tab-commit">
            {i18n.t.dash.git.tabCommit}
          </Tabs.Trigger>
          <Tabs.Trigger value="changes" data-testid="detail-tab-changes">
            {i18n.t.dash.git.tabChanges}{detail?.files?.length ? ` ${detail.files.length}` : ""}
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <!-- The file list's own controls, in its corner, the way Fork places them. -->
      <div class="flex items-center gap-0.5">
        <Button
          variant={fileView === "tree" ? "secondary" : "ghost"}
          size="icon"
          class="size-7"
          aria-pressed={fileView === "tree"}
          title={i18n.t.dash.git.fileViewTree}
          data-testid="detail-file-tree"
          onclick={() => (fileView = "tree")}
        >
          <FolderTreeIcon class="size-4" />
          <span class="sr-only">{i18n.t.dash.git.fileViewTree}</span>
        </Button>
        <Button
          variant={fileView === "list" ? "secondary" : "ghost"}
          size="icon"
          class="size-7"
          aria-pressed={fileView === "list"}
          title={i18n.t.dash.git.fileViewList}
          data-testid="detail-file-list"
          onclick={() => (fileView = "list")}
        >
          <ListIcon class="size-4" />
          <span class="sr-only">{i18n.t.dash.git.fileViewList}</span>
        </Button>
        <Button
          variant={expandAll ? "secondary" : "ghost"}
          size="icon"
          class="size-7"
          aria-pressed={expandAll}
          title={i18n.t.dash.git.expandAll}
          data-testid="detail-expand-all"
          onclick={() => (expandAll = !expandAll)}
        >
          <UnfoldVerticalIcon class="size-4" />
          <span class="sr-only">{i18n.t.dash.git.expandAll}</span>
        </Button>
      </div>
    </div>
  {/if}
  <CommitDetail
    commit={selectedCommit}
    {detail}
    pending={dock.pending}
    loading={dock.loading}
    onRetry={() => void dock.retryDetail()}
    formatDate={formatDetailDate}
    height={detailHeight}
    view={detailView}
    {fileView}
    {expandAll}
    {selectedPath}
    onSelectFile={(path) => (selectedPath = selectedPath === path ? null : path)}
    {t}
  />
</div>
