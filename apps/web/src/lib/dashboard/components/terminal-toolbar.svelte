<script lang="ts">
  /** Responsive product chrome above the terminal grid. */
  import type { GridMode, TerminalLayout } from "@pdmux/core";
  import { GRID_SIZE } from "@pdmux/core";
  import SquareIcon from "@lucide/svelte/icons/square";
  import ColumnsIcon from "@lucide/svelte/icons/columns-2";
  import Grid2Icon from "@lucide/svelte/icons/grid-2x2";
  import Grid3Icon from "@lucide/svelte/icons/grid-3x3";
  import PanelLeftIcon from "@lucide/svelte/icons/panel-left";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import FolderTreeIcon from "@lucide/svelte/icons/folder-tree";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as ToggleGroup from "#lib/components/ui/toggle-group/index.js";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
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
    onToggleFiles,
    onAdd,
  }: {
    layout: TerminalLayout;
    pages: number;
    page: number;
    relayStatus?: RelayStatus;
    feedError?: string | null;
    /** A phone keeps only paging and the primary add action in this row. */
    compact?: boolean;
    onMode: (mode: GridMode) => void;
    onPage: (delta: number) => void;
    onToggleSidebar: () => void;
    onToggleDock: () => void;
    onToggleFiles: () => void;
    onAdd: (anchor: HTMLElement) => void;
  } = $props();

  const i18n = getI18n();
  const modes = Object.keys(GRID_SIZE) as GridMode[];
  const modeLabel = (mode: GridMode): string => i18n.t.dash.mode[mode];

  function getSelectedMode(): string {
    return layout.mode;
  }

  function selectMode(value: string): void {
    const mode = value as GridMode;
    if (!modes.includes(mode) || mode === layout.mode) return;
    onMode(mode);
  }
</script>

<Tooltip.Provider delayDuration={300}>
  <div
    class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
    class:min-h-11={compact}
    data-testid="terminal-toolbar"
  >
    {#if !compact}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={layout.sidebarOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={i18n.t.dash.sidebarToggle}
              aria-pressed={layout.sidebarOpen}
              data-testid="toggle-sidebar"
              onclick={onToggleSidebar}
            >
              <PanelLeftIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{i18n.t.dash.sidebarToggle}</Tooltip.Content>
      </Tooltip.Root>

      <ToggleGroup.Root
        type="single"
        bind:value={getSelectedMode, selectMode}
        variant="outline"
        aria-label={i18n.t.dash.mode.label}
      >
        {#each modes as mode (mode)}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <ToggleGroup.Item
                  {...props}
                  value={mode}
                  class="size-8 px-0"
                  aria-label={modeLabel(mode)}
                  data-testid={`mode-${mode}`}
                >
                  {#if mode === "tab"}
                    <SquareIcon class="size-4" />
                  {:else if mode === "split2"}
                    <ColumnsIcon class="size-4" />
                  {:else if mode === "split4"}
                    <Grid2Icon class="size-4" />
                  {:else}
                    <Grid3Icon class="size-4" />
                  {/if}
                </ToggleGroup.Item>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>{modeLabel(mode)}</Tooltip.Content>
          </Tooltip.Root>
        {/each}
      </ToggleGroup.Root>
    {/if}

    <div class="flex items-center gap-1">
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="icon"
              class={compact ? "size-11" : "size-8"}
              aria-label={i18n.t.dash.prevPage}
              data-testid="page-prev"
              disabled={pages <= 1}
              onclick={() => onPage(-1)}
            >
              <ChevronLeftIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{i18n.t.dash.prevPage}</Tooltip.Content>
      </Tooltip.Root>
      <span class="text-muted-foreground min-w-14 text-center tabular-nums" data-testid="page-indicator">
        {fmt(i18n.t.dash.page, { page: page + 1, total: pages })}
      </span>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="icon"
              class={compact ? "size-11" : "size-8"}
              aria-label={i18n.t.dash.nextPage}
              data-testid="page-next"
              disabled={pages <= 1}
              onclick={() => onPage(1)}
            >
              <ChevronRightIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{i18n.t.dash.nextPage}</Tooltip.Content>
      </Tooltip.Root>
    </div>

    <Button
      size={compact ? "lg" : "default"}
      class={compact ? "h-11 min-w-11 px-3" : "h-8 px-3"}
      aria-label={i18n.t.dash.addTerminal}
      data-testid="add-terminal"
      onclick={(event: MouseEvent) => onAdd(event.currentTarget as HTMLElement)}
    >
      <SquareTerminalIcon class="size-4" />
      <PlusIcon class="size-4" />
      <span class="max-[359px]:hidden">{i18n.t.dash.addTerminal}</span>
    </Button>

    <span class="flex-1"></span>

    {#if feedError}
      <span class="text-destructive" data-testid="feed-error">{i18n.t.dash.feedError}</span>
    {/if}
    {#if relayStatus === "reconnecting"}
      <span class="text-destructive" data-testid="relay-status">{i18n.t.dash.terminal.reconnecting}</span>
    {/if}

    {#if !compact}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={layout.dockOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={i18n.t.dash.dockToggle}
              aria-pressed={layout.dockOpen}
              data-testid="toggle-dock"
              onclick={onToggleDock}
            >
              <GitBranchIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{i18n.t.dash.dockToggle}</Tooltip.Content>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={layout.filesOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={i18n.t.dash.files.toggle}
              aria-pressed={layout.filesOpen}
              data-testid="toggle-files"
              onclick={onToggleFiles}
            >
              <FolderTreeIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{i18n.t.dash.files.toggle}</Tooltip.Content>
      </Tooltip.Root>
    {/if}
  </div>
</Tooltip.Provider>
