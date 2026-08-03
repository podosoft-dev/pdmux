<script lang="ts">
  /**
   * The one row of chrome above the terminals.
   *
   * It is app furniture, not a package component: which buttons a dashboard wants
   * (and where its "manage hosts" link goes) is exactly the kind of decision
   * `@pdmux/ui` refuses to make for its consumers.
   *
   * The split buttons are not radio buttons — pressing the ACTIVE one again pages
   * forward, so the same button walks a fleet (1-4 -> 5-8 -> …). `cycleMode` in
   * `@pdmux/core` owns that rule; this only reports the press.
   */
  import type { GridMode, TerminalLayout } from "@pdmux/core";
  import { GRID_SIZE } from "@pdmux/core";
  import { Button } from "$lib/components/ui/button";
  import { fmt, getI18n } from "$lib/i18n";
  import type { RelayStatus } from "../terminal-relay";

  let {
    layout,
    pages,
    page,
    relayStatus = "idle",
    feedError = null,
    compact = false,
    onMode,
    onPage,
    onToggleSidebar,
    onToggleDock,
    onToggleClickAction,
    onAdd,
  }: {
    layout: TerminalLayout;
    pages: number;
    page: number;
    relayStatus?: RelayStatus;
    feedError?: string | null;
    /**
     * Drop everything a narrow screen answers elsewhere.
     *
     * Eleven controls in one row is a wrapping mess on a phone, and most of them are
     * already covered: the sidebar and dock toggles are what the tab bar does, and the
     * split modes have no meaning when one pane fills the screen. What is left is the
     * pager, "add", and the click-action switch.
     */
    compact?: boolean;
    onMode: (mode: GridMode) => void;
    onPage: (delta: number) => void;
    onToggleSidebar: () => void;
    onToggleDock: () => void;
    onToggleClickAction: () => void;
    onAdd: (anchor: HTMLElement) => void;
  } = $props();

  const i18n = getI18n();
  const modes = Object.keys(GRID_SIZE) as GridMode[];
  const modeLabel = (mode: GridMode): string => i18n.t.dash.mode[mode];
  const clickActionLabel = $derived(
    layout.clickAction === "zoom" ? i18n.t.dash.clickAction.zoom : i18n.t.dash.clickAction.focus,
  );
</script>

<div class="flex flex-wrap items-center gap-1.5 text-xs" data-testid="terminal-toolbar">
  <!-- The glyph buttons carry an `aria-label` as well as a `title`: a tooltip does not
       exist on a touch screen, so `title` alone leaves them unlabelled where it matters
       most. -->
  {#if !compact}
    <Button
      variant="outline"
      size="sm"
      class="h-7 px-2"
      title={i18n.t.dash.sidebarToggle}
      aria-label={i18n.t.dash.sidebarToggle}
      data-testid="toggle-sidebar"
      onclick={onToggleSidebar}>{layout.sidebarOpen ? "◧" : "▢"}</Button
    >

    <span class="text-muted-foreground ml-1">{i18n.t.dash.mode.label}</span>
    {#each modes as mode (mode)}
      <!-- Square, but NOT `size="icon-sm"`: that variant drops `sm`'s `text-[0.8rem]` back
           to the base `text-sm` because it is sized for an SVG, and these hold a digit —
           swapping it grew the labels 12.8px → 14px, out of step with the rest of the bar.
           `sm` plus a square override is the smaller lie. -->
      <Button
        variant={layout.mode === mode ? "default" : "outline"}
        size="sm"
        class="h-7 w-7 p-0"
        title={i18n.t.dash.mode.hint}
        aria-label={`${i18n.t.dash.mode.label} ${modeLabel(mode)}`}
        data-testid={`mode-${mode}`}
        aria-pressed={layout.mode === mode}
        onclick={() => onMode(mode)}>{modeLabel(mode)}</Button
      >
    {/each}
  {/if}

  <Button
    variant="outline"
    size="sm"
    class="h-7 px-2"
    title={i18n.t.dash.prevPage}
    aria-label={i18n.t.dash.prevPage}
    data-testid="page-prev"
    onclick={() => onPage(-1)}>‹</Button
  >
  <span class="text-muted-foreground tabular-nums" data-testid="page-indicator"
    >{fmt(i18n.t.dash.page, { page: page + 1, total: pages })}</span
  >
  <Button
    variant="outline"
    size="sm"
    class="h-7 px-2"
    title={i18n.t.dash.nextPage}
    aria-label={i18n.t.dash.nextPage}
    data-testid="page-next"
    onclick={() => onPage(1)}>›</Button
  >

  <Button
    variant="outline"
    size="sm"
    class="h-7 px-2"
    data-testid="add-terminal"
    onclick={(event: MouseEvent) => onAdd(event.currentTarget as HTMLElement)}
    >{i18n.t.dash.addTerminal}</Button
  >
  <Button
    variant="ghost"
    size="sm"
    class="h-7 px-2"
    title={i18n.t.dash.clickAction.label}
    data-testid="toggle-click-action"
    onclick={onToggleClickAction}>{i18n.t.dash.clickAction.label}: {clickActionLabel}</Button
  >

  <span class="flex-1"></span>

  {#if feedError}
    <span class="text-destructive" data-testid="feed-error">{i18n.t.dash.feedError}</span>
  {/if}
  {#if relayStatus === "reconnecting"}
    <span class="text-destructive" data-testid="relay-status">{i18n.t.dash.terminal.reconnecting}</span>
  {/if}

  {#if !compact}
    <Button
      variant="outline"
      size="sm"
      class="h-7 px-2"
      title={i18n.t.dash.dockToggle}
      aria-label={i18n.t.dash.dockToggle}
      data-testid="toggle-dock"
      onclick={onToggleDock}>{layout.dockOpen ? "◨" : "▤"}</Button
    >
  {/if}
</div>
