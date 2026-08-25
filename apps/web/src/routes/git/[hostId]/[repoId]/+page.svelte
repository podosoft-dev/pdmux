<script lang="ts">
  /**
   * The commit dock as a page — the same component the dashboard docks, so a
   * detached window cannot drift from the docked one.
   */
  import "@pdmux/ui/styles.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { DETAIL_HEIGHT_MAX, DETAIL_HEIGHT_MIN } from "@pdmux/core";
  import { getI18n } from "#lib/i18n/index.js";
  import CommitDock from "#lib/dashboard/components/commit-dock.svelte";
  import { GitDock } from "#lib/dashboard/git-dock.svelte.ts";
  import type { HostView } from "#lib/dashboard/types.js";
  import { uiTranslate } from "#lib/dashboard/ui-i18n.js";

  let { data }: { data: { hostId: string; repoId: string; hosts: HostView[] } } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));
  const dock = new GitDock();

  const clampDetailHeight = (px: number): number =>
    Math.min(DETAIL_HEIGHT_MAX, Math.max(DETAIL_HEIGHT_MIN, Math.round(px)));

  /**
   * Open by default here: a detached window has the full viewport, which is the case
   * the panel was designed for. It is local state — this window is not the user's
   * saved dashboard layout, and the stylesheet drops the panel anyway once the graph's
   * own column gets too narrow to seat both.
   */
  let refsOpen = $state(true);

  /**
   * Detail height, also local. A detached window is a look at one repository, not the
   * user's saved dashboard, so its proportions do not follow them back to the dock.
   */
  let detailHeight = $state<number | null>(null);
  let detailBase: number | null = null;

  function dragDetail(delta: number, commit: boolean): void {
    detailBase ??=
      detailHeight ??
      Math.round(document.querySelector("[data-pdmux-detail]")?.getBoundingClientRect().height ?? 240);
    detailHeight = clampDetailHeight(detailBase + delta);
    if (commit) detailBase = null;
  }

  onMount(() => void dock.openHost(data.hostId, data.repoId));
</script>

<svelte:head><title>{i18n.t.dash.git.title} · pdmux</title></svelte:head>

<div class="pdmux flex flex-col" style="height:100dvh" data-testid="detached-git">
  <CommitDock
    {dock}
    hosts={data.hosts}
    {t}
    {refsOpen}
    {detailHeight}
    onToggleRefs={() => (refsOpen = !refsOpen)}
    onDetailResize={dragDetail}
    onHostChange={(hostId) => void dock.openHost(hostId)}
    onRepoChange={(repoId) => {
      // The URL is the identity of this window: navigating keeps a reload (and a
      // bookmark) on the repository the user is actually looking at.
      void goto(`/git/${dock.hostId ?? data.hostId}/${repoId}`, { replace: true, reset: false });
      void dock.openRepo(repoId);
    }}
  />
</div>
