<script lang="ts">
  /**
   * The dashboard's own half of the shell: terminals and the commit graph.
   *
   * The host sidebar and the splitter beside it belong to `(shell)/+layout.svelte`, so
   * what is left here is the right-hand side — toolbar, terminal grid, dock — plus the
   * decisions that drive them. Every state transition is a pure reducer from
   * `@pdmux/core` (`cycleMode`, `pickerApply`, `toggleZoom`, …) and every pixel is a
   * component from `@pdmux/ui`. That split is what makes the same behaviour testable
   * without a browser and reusable outside this app — and it is why there is no bespoke
   * grid maths here to get wrong.
   *
   * ⚠ These three elements are direct children of the shell's grid and fill its last
   * three tracks. Wrapping them in a div would collapse all three into one.
   */
  // xterm ships its own stylesheet and the package deliberately does not import it
  // (a consumer that never opens a terminal should not pay for it). The dashboard
  // always can, so it does — without it the terminal renders in the wrong place.
  import "@xterm/xterm/css/xterm.css";
  import { onMount, untrack } from "svelte";
  import { page as appPage } from "$app/state";
  import { SplitHandle, TerminalGrid, TerminalTargetPicker } from "@pdmux/ui";
  import type { FsDirView, PickerTarget } from "@pdmux/ui";
  import { MediaQuery } from "svelte/reactivity";
  import {
    SHELL_STACK_MAX_WIDTH,
    type GridMode,
    type HistoryLine,
    type TerminalSlot,
    clampedPage,
    clearSlot,
    cycleMode,
    focusSlot,
    movePage,
    pageCount,
    parseAnsiLines,
    pickerApply,
    removeSlot,
    setClickAction,
    setDockTarget,
    setDockWidth,
    swapSlots,
    setDockDetailHeight,
    slotLabel,
    soloIndex,
    soloLayout,
    soloStep,
    setFilesShare,
    setFilesTarget,
    toggleDock,
    toggleDockRefs,
    toggleFiles,
    toggleSidebar,
    toggleZoom,
  } from "@pdmux/core";
  import { toast } from "svelte-sonner";
  import { errorCode, terminalApi } from "$lib/dashboard/api";
  import { fmt, getI18n } from "$lib/i18n";
  import CommitDock from "$lib/dashboard/components/commit-dock.svelte";
  import FilesDockPanel from "$lib/dashboard/components/files-dock.svelte";
  import ConfirmDialog from "$lib/dashboard/components/confirm-dialog.svelte";
  import TerminalToolbar from "$lib/dashboard/components/terminal-toolbar.svelte";
  import { gridHosts, pickerHosts } from "$lib/dashboard/map";
  import { dismissOnOutside } from "$lib/dashboard/popover-dismiss.svelte";
  import { useShellState } from "$lib/dashboard/shell-state.svelte";
  import { uiTranslate } from "$lib/dashboard/ui-i18n";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));
  const shell = useShellState();

  const layout = $derived(shell.layout);
  const grid = $derived(gridHosts(shell.feed.hosts));

  /**
   * A narrow screen renders ONE pane — and renders it from a projection, never by writing
   * to the stored layout. `layout.mode` is the user's desktop split, persisted per user
   * and shared across devices: a phone that saved `tab` would silently reduce their
   * desktop to one terminal. `SHELL_STACK_MAX_WIDTH` is the same number the stylesheet
   * stacks at, so the CSS and this code cannot disagree about how many cells are shown.
   *
   * ⚠ `MediaQuery` DIRECTLY, NOT `IsMobile`, for one reason: the second argument.
   *
   * A media query has no answer on the server, and its default assumption is "not
   * matching" — i.e. desktop. So a phone server-rendered the full saved split and then
   * collapsed to one pane the instant it hydrated: the whole 3x3 appearing and vanishing
   * on every refresh. Seeding the fallback with the request's own hint makes first paint
   * agree with what the device will decide a moment later.
   *
   * `IsMobile` is a managed file and takes no fallback, so this is spelled out here
   * rather than forked. `SHELL_STACK_MAX_WIDTH - 1` is exactly what that hook computes,
   * and the stylesheet stacks at the same number.
   */
  // `untrack`: the hint is a SEED for the first render, deliberately not reactive — the
  // live media query is what may change afterwards, and re-seeding from a loader re-run
  // would fight it.
  const stacked = new MediaQuery(`max-width: ${SHELL_STACK_MAX_WIDTH - 1}px`, untrack(() => data.phoneHint));
  const coarse = new MediaQuery("pointer: coarse");
  /** Cursor override, so the pager can sit on an EMPTY cell (which has no slot to focus). */
  let cursor = $state<number | null>(null);
  const soloAt = $derived(cursor ?? soloIndex(layout));
  const viewLayout = $derived(stacked.current ? soloLayout(layout, soloAt) : layout);
  const pages = $derived(pageCount(viewLayout));
  /**
   * `?gesture=1` draws the gesture readout over every pane.
   *
   * ⚠ IT EXISTS BECAUSE A PHONE HAS NO CONSOLE. "Scrolling works sometimes" could only be
   * answered from the device it happens on, and the three routes a drag can take (a wheel to the
   * program, a request for the multiplexer's history, or nothing) are invisible from the outside.
   * The URL owns the flag rather than a setting: it is a debugging session, not a preference, and
   * it must not survive into somebody else's screen.
   */
  const diagnostics = $derived(appPage.url.searchParams.get("gesture") === "1");

  const page = $derived(clampedPage(viewLayout));

  /**
   * The pager. On a desktop it turns the page; on a phone, where a page IS one cell, it
   * steps terminal by terminal — the same rule with a window of one, including the spare
   * empty cell at the end that is how a phone reaches "add a terminal".
   */
  function paged(delta: number): void {
    if (!stacked.current) {
      shell.apply(movePage(layout, delta));
      return;
    }
    const next = soloStep(layout, soloAt, delta);
    cursor = next;
    // ⚠ The cursor stays LOCAL — no `apply()`.
    //
    // The layout is one row shared by every device this user is signed in on, so writing
    // "which cell a phone is looking at" travels to their desktop and moves the focus ring
    // there. Paging on a phone is navigation, not a change to the arrangement. The pane's
    // own tap still focuses it (that is what raises the software keyboard).
  }
  const takenSessions = $derived(
    layout.slots.filter((slot): slot is TerminalSlot => Boolean(slot?.session)).map((slot) => slot.session ?? ""),
  );

  // --- terminal target picker -----------------------------------------------
  type Anchor = { x: number; y: number };
  let picker = $state<{ index: number | null; hostId: string | null; anchor: Anchor } | null>(null);

  function openPicker(index: number | null, element: HTMLElement): void {
    const slot = index === null ? null : layout.slots[index];
    const rect = element.getBoundingClientRect();
    picker = {
      index,
      hostId: slot?.hostId ?? shell.feed.hosts[0]?.id ?? null,
      anchor: { x: rect.left, y: rect.bottom },
    };
  }

  dismissOnOutside(
    () => picker !== null,
    () => (picker = null),
  );

  function applyPicker(target: PickerTarget, index: number | null): void {
    shell.apply(
      pickerApply(layout, index, { hostId: target.hostId, kind: target.kind, session: target.session ?? null }),
    );
    picker = null;
  }

  function detach(slot: TerminalSlot): void {
    const params = new URLSearchParams({ host: slot.hostId, kind: slot.kind });
    if (slot.session) params.set("session", slot.session);
    window.open(`/terminal?${params.toString()}`, "_blank", "noopener");
  }

  // --- reaching a pane's scrollback -----------------------------------------
  /**
   * The pane asks; this owns the network, because `@pdmux/ui` may not (`[TC-PDUI-030]`).
   *
   * ⚠ ONLY A MULTIPLEXER PANE HAS ANY OF THIS TO OFFER. A `shell` pane has no session
   * to address, and xterm is already holding its scrollback — Shift+wheel scrolls it in
   * the browser and never reaches here.
   */
  function muxSession(slot: TerminalSlot): string | null {
    return slot.kind === "shell" || !slot.session ? null : slot.session;
  }

  async function scrollback(slot: TerminalSlot, action: "enter" | "exit"): Promise<void> {
    const session = muxSession(slot);
    if (!session) return;
    try {
      await terminalApi.copyMode(slot.hostId, session, action);
    } catch (cause) {
      // A refusal here is worth saying out loud: the gesture did nothing, and the pane
      // looks exactly the same either way. Branch on the code, never the message.
      const reason =
        errorCode(cause) === "MUX_NOT_FOUND"
          ? i18n.t.pdmux.pane.scrollbackNoMux
          : i18n.t.pdmux.pane.scrollbackUnavailable;
      toast.error(fmt(i18n.t.pdmux.pane.scrollbackFailed, { reason }));
    }
  }

  async function readHistory(
    slot: TerminalSlot,
  ): Promise<{ lines: HistoryLine[]; scrollback: boolean; screenOnly?: boolean } | null> {
    const session = muxSession(slot);
    if (!session) return null;
    try {
      const { lines, screenOnly } = await terminalApi.history(slot.hostId, session);
      // ⚠ THE PARSE HAPPENS HERE, NOT ON THE SERVER. What crosses the wire is what tmux
      // wrote, escapes included; turning it into runs is a rendering decision and it
      // keeps the API from having an opinion about colour it would then have to keep.
      const parsed = parseAnsiLines(lines);
      /**
       * ⚠ AN EMPTY ANSWER IS NOT A FAILURE, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS
       * ROUND TRIP. Returning `null` for both meant the sheet fell back to the visible screen
       * with a note about the multiplexer holding the history — which is a lie when the
       * multiplexer holds nothing, and that is exactly the case a coding agent's TUI creates
       * (`screenOnly`). So an empty answer is reported as an answer.
       */
      return { lines: parsed, scrollback: parsed.length > 0, screenOnly };
    } catch (cause) {
      /**
       * ⚠ SILENCE HERE COST SOMEBODY A TRIP TO ANOTHER MACHINE. The sheet used to keep the
       * local buffer and say nothing, so a refusal read as "this pane printed one screen".
       * `null` now means the ask failed, and the sheet has a line for that; the code is worth
       * a toast as well, exactly as `scrollback()` above does — same reasons, same branch.
       */
      const reason =
        errorCode(cause) === "MUX_NOT_FOUND" ? i18n.t.pdmux.pane.scrollbackNoMux : i18n.t.pdmux.pane.scrollbackUnavailable;
      toast.error(fmt(i18n.t.pdmux.history.failedToast, { reason }));
      return null;
    }
  }

  // --- dock splitter --------------------------------------------------------
  // The handle reports a delta from where the gesture STARTED, so the width it is
  // applied to has to be the width the gesture started from — adding it to the current
  // width would compound every pointer move into a runaway column.
  let dockBase: number | null = null;

  function dragDock(delta: number, commit: boolean): void {
    dockBase ??= layout.dockWidth;
    const next = setDockWidth(layout, dockBase + delta);
    if (commit) dockBase = null;
    shell.apply(next);
  }

  /**
   * The dock column's own split, measured as a SHARE.
   *
   * ⚠ THE DELTA IS PIXELS AND THE STATE IS A PERCENTAGE, so the column's height has
   * to be read at the moment of the drag — a share computed against a remembered
   * height drifts the instant the window is resized. `invert` on the handle means a
   * drag upward grows the panel below it, which is the file explorer.
   */
  let dockColumn = $state<HTMLElement | null>(null);
  let filesBase: number | null = null;

  function dragFilesSplit(delta: number, commit: boolean): void {
    const height = dockColumn?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    filesBase ??= layout.filesShare;
    const next = setFilesShare(layout, filesBase + (delta / height) * 100);
    if (commit) filesBase = null;
    shell.apply(next);
  }

  // --- files dock -----------------------------------------------------------
  /**
   * ⚠ THE LAYOUT REMEMBERS WHERE IT WAS LOOKING, and this is where that is written.
   * The store owns the fetching and knows nothing about persistence; recording it
   * here keeps "what the user is doing" in one document with the rest of the shell.
   */
  function rememberFiles(): void {
    const at = layout.filesTarget;
    if (at?.hostId === shell.files.hostId && at?.path === shell.files.path) return;
    shell.apply(setFilesTarget(layout, shell.files.hostId, shell.files.path));
  }

  function openFilesHost(hostId: string): void {
    void shell.files.openHost(hostId).then(rememberFiles);
  }

  function openFilesDir(path: string): void {
    void shell.files.openDir(path).then(rememberFiles);
  }

  function navigateFiles(input: string): void {
    void shell.files.navigate(input, shell.files.dir?.home ?? null).then(rememberFiles);
  }

  // --- commit dock ----------------------------------------------------------
  function openDockHost(hostId: string): void {
    shell.apply(setDockTarget(layout, { hostId, repo: null }));
    void shell.dock.openHost(hostId);
  }

  function openDockRepo(repoId: string): void {
    shell.apply(setDockTarget(layout, { hostId: shell.dock.hostId ?? "", repo: repoId }));
    void shell.dock.openRepo(repoId);
  }

  // --- closing a pane ------------------------------------------------------
  // The ✕ sits in a title bar between zoom and detach, all three one click apart, and
  // a mis-click used to throw away a pane the user was reading. It is cheap to undo
  // (the session survives on the host) but not free, so it asks — and the wording says
  // what does NOT happen, which is what the user actually worries about.
  let closeOpen = $state(false);
  let closing = $state<{ index: number; label: string } | null>(null);

  function askClose(index: number): void {
    const slot = layout.slots[index];
    if (!slot) return;
    const host = grid.find((entry) => entry.id === slot.hostId);
    closing = { index, label: slotLabel(slot, host?.name ?? slot.hostId) };
    closeOpen = true;
  }

  function confirmClose(): void {
    if (!closing) return;
    shell.apply(clearSlot(layout, closing.index));
    closing = null;
  }

  /**
   * The detail's height, resized. Same shape as the column drags: the delta is measured
   * from where the gesture started, so it must be added to the height the gesture
   * started from — adding it to the current height compounds every pointer move.
   *
   * The base falls back to the panel's measured height, because the first drag happens
   * while the panel is still content-sized and has no stored number to start from.
   */
  let detailBase: number | null = null;

  function dragDetail(delta: number, commit: boolean): void {
    detailBase ??=
      layout.dockDetailHeight ??
      Math.round(document.querySelector("[data-pdmux-detail]")?.getBoundingClientRect().height ?? 240);
    const next = setDockDetailHeight(layout, detailBase + delta);
    if (commit) detailBase = null;
    shell.apply(next);
  }

  function detachDock(): void {
    if (!shell.dock.hostId || !shell.dock.repoId) return;
    window.open(`/git/${shell.dock.hostId}/${shell.dock.repoId}`, "_blank", "noopener");
  }

  onMount(() => {
    // The dock's data lives in the shell's state, so returning from /hosts finds it
    // already pointed at a repository — re-opening it here would re-fetch that graph
    // for nothing (and lose the selected commit).
    if (shell.dock.hostId) return;
    const target = layout.dockTarget ?? { hostId: data.hosts[0]?.id ?? null, repo: null };
    if (target.hostId) void shell.dock.openHost(target.hostId, target.repo);
  });

  onMount(() => {
    // Same contract as the dock above: already pointed somewhere means a return from
    // another route, and re-opening would re-read a directory for nothing.
    // ⚠ NO FALLBACK TO THE FIRST HOST. A repository graph is the same question on any
    // host; a home directory is not, and opening somebody's files because they opened
    // a panel is a decision the panel does not get to make.
    if (shell.files.hostId) return;
    const at = layout.filesTarget;
    if (at?.hostId) void shell.files.open(at.hostId, at.path);
  });
</script>

<svelte:head><title>{i18n.t.dash.title} · pdmux</title></svelte:head>

<div class="pdmux pdmux-panel" data-pdmux-region="terminal">
  <TerminalToolbar
    {layout}
    {pages}
    {page}
    relayStatus={shell.relayStatus}
    feedError={shell.feed.error}
    onMode={(mode: GridMode) => shell.apply(cycleMode(layout, mode))}
    onPage={paged}
    onToggleSidebar={() => shell.apply(toggleSidebar(layout))}
    onToggleDock={() => shell.apply(toggleDock(layout))}
    onToggleFiles={() => shell.apply(toggleFiles(layout))}
    onToggleClickAction={() => shell.apply(setClickAction(layout, layout.clickAction === "zoom" ? "focus" : "zoom"))}
    onAdd={(element: HTMLElement) => openPicker(null, element)}
    compact={stacked.current}
  />
  <TerminalGrid
    layout={viewLayout}
    onScreen={!stacked.current || shell.view === "terminal"}
    keyBar={coarse.current}
    hosts={grid}
    adapter={shell.relay}
    {t}
    onAssign={openPicker}
    onClose={askClose}
    onRemove={(index: number) => shell.apply(removeSlot(layout, index))}
    onZoom={(slotId: string) =>
      // Zoom means nothing when one pane already fills the screen, and writing `zoomId`
      // would put a phone's tap into the layout the user's desktop reads. A tap there is a
      // focus — which is also what raises the software keyboard.
      shell.apply(stacked.current ? focusSlot(layout, slotId) : toggleZoom(layout, slotId))}
    onFocus={(slotId: string) => shell.apply(focusSlot(layout, slotId))}
    onSwap={(from: number, to: number) => shell.apply(swapSlots(layout, from, to))}
    onDetach={detach}
    onScrollback={(slot: TerminalSlot, action: "enter" | "exit") => void scrollback(slot, action)}
    onReadHistory={readHistory}
    {diagnostics}
    transport={shell.relayStatus}
  />
</div>

<SplitHandle invert {t} onDrag={(delta) => dragDock(delta, false)} onCommit={(delta) => dragDock(delta, true)} />

<!--
  ⚠ THIS ELEMENT IS THE DOCK REGION — it wears `data-pdmux-region="dock"` because the
  shell's LAST TRACK is placed by that name, and on a phone the same name is what the
  `Git` tab shows. Handing it to the commit panel instead (where it used to live) left
  the column unplaced: measured on a 390px viewport, the tab showed nothing at all.

  ⚠ ONE GRID TRACK, TWO PANELS. The shell grid has five columns and the last is the
  dock; the file explorer shares it rather than taking a sixth, because a second
  resizable column would come out of the terminals' width — and the terminals are why
  anyone opened the page. Each panel toggles on its own, so an operator can watch a
  build and read the tree it is building at the same time.
-->
<div
  class="pdmux pdmux-dock-column"
  data-pdmux-region="dock"
  data-pdmux-split={layout.dockOpen && layout.filesOpen ? "both" : "single"}
  bind:this={dockColumn}
>
  {#if layout.dockOpen}
    <div class="pdmux-dock-slot" style:flex-basis={`${layout.filesOpen ? 100 - layout.filesShare : 100}%`}>
      <CommitDock
        dock={shell.dock}
        hosts={shell.feed.hosts}
        {t}
        refsOpen={!layout.dockRefsHidden}
        detailHeight={layout.dockDetailHeight}
        onDetailResize={dragDetail}
        onHostChange={openDockHost}
        onRepoChange={openDockRepo}
        onToggleRefs={() => shell.apply(toggleDockRefs(layout))}
        onDetach={detachDock}
      />
    </div>
  {/if}

  {#if layout.dockOpen && layout.filesOpen}
    <SplitHandle
      axis="y"
      invert
      {t}
      onDrag={(delta) => dragFilesSplit(delta, false)}
      onCommit={(delta) => dragFilesSplit(delta, true)}
    />
  {/if}

  {#if layout.filesOpen}
    <div class="pdmux-dock-slot" style:flex-basis={`${layout.dockOpen ? layout.filesShare : 100}%`}>
      <FilesDockPanel
        files={shell.files}
        hosts={shell.feed.hosts}
        {t}
        onHostChange={openFilesHost}
        onOpenDir={openFilesDir}
        onNavigate={navigateFiles}
      />
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={closeOpen}
  title={i18n.t.dash.terminal.closeTitle}
  warning={fmt(i18n.t.dash.terminal.closeWarning, { label: closing?.label ?? "" })}
  confirmLabel={i18n.t.dash.terminal.closeConfirm}
  testId="pane-close-confirm"
  onConfirm={confirmClose}
/>

{#if picker}
  <TerminalTargetPicker
    hosts={pickerHosts(shell.feed.hosts)}
    index={picker.index}
    hostId={picker.hostId}
    taken={takenSessions}
    anchor={picker.anchor}
    {t}
    onApply={applyPicker}
    onCancel={() => (picker = null)}
  />
{/if}
