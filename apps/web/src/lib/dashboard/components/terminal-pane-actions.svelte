<script lang="ts">
  /** Product chrome for the operations exposed by `@pdmux/ui`'s terminal pane. */
  import type { TerminalPaneActionContext } from "@pdmux/ui";
  import ReplaceIcon from "@lucide/svelte/icons/replace";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import MaximizeIcon from "@lucide/svelte/icons/maximize-2";
  import MinimizeIcon from "@lucide/svelte/icons/minimize-2";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import XIcon from "@lucide/svelte/icons/x";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import FocusIcon from "@lucide/svelte/icons/focus";
  import SquareIcon from "@lucide/svelte/icons/square";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import { getI18n } from "#lib/i18n/index.js";

  let {
    actions,
    compact = false,
    standalone = false,
  }: {
    actions: TerminalPaneActionContext;
    compact?: boolean;
    standalone?: boolean;
  } = $props();

  const i18n = getI18n();
  const buttonClass = $derived(compact ? "size-11" : "size-7");
</script>

<Tooltip.Provider delayDuration={300}>
  <span class="pdmux-pane-acts" data-testid="pane-actions">
    {#if !standalone}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            class={buttonClass}
            aria-label={i18n.t.pdmux.pane.retarget}
            data-pdmux-retarget
            onclick={(event: MouseEvent) => actions.retarget(event.currentTarget as HTMLElement)}
          >
            <ReplaceIcon class="size-4" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">{i18n.t.pdmux.pane.retarget}</Tooltip.Content>
    </Tooltip.Root>
    {/if}

    {#if !compact && actions.canScrollback}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class={buttonClass}
              aria-label={i18n.t.pdmux.pane.scrollback}
              aria-pressed={actions.scrollMode}
              data-pdmux-scrollback
              onclick={actions.toggleScrollback}
            >
              <ChevronsUpDownIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom">{i18n.t.pdmux.pane.scrollback}</Tooltip.Content>
      </Tooltip.Root>
    {/if}

    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            class={buttonClass}
            aria-label={i18n.t.pdmux.pane.history}
            data-pdmux-history
            onclick={actions.showOutput}
          >
            <ScrollTextIcon class="size-4" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">{i18n.t.pdmux.pane.history}</Tooltip.Content>
    </Tooltip.Root>

    {#if !compact && !standalone}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class={buttonClass}
              aria-label={actions.zoomed ? i18n.t.pdmux.pane.zoomOut : i18n.t.pdmux.pane.zoomIn}
              data-pdmux-zoom
              onclick={actions.toggleZoom}
            >
              {#if actions.zoomed}
                <MinimizeIcon class="size-4" />
              {:else}
                <MaximizeIcon class="size-4" />
              {/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom">
          {actions.zoomed ? i18n.t.pdmux.pane.zoomOut : i18n.t.pdmux.pane.zoomIn}
        </Tooltip.Content>
      </Tooltip.Root>
    {/if}

    {#if !standalone || actions.viewport || actions.terminate}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            class={buttonClass}
            title={i18n.t.pdmux.pane.more}
            aria-label={i18n.t.pdmux.pane.more}
            data-pdmux-pane-more
          >
            <EllipsisIcon class="size-4" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-52" data-testid="pane-actions-menu">
        {#if actions.viewport}
          <DropdownMenu.Item onSelect={() => actions.followCursor?.()} data-pdmux-follow>
            <FocusIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.followCursor}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.pan?.(-10, 0)} data-pdmux-pan-left>
            <ArrowLeftIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.panLeft}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.pan?.(10, 0)} data-pdmux-pan-right>
            <ArrowRightIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.panRight}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.pan?.(0, -5)} data-pdmux-pan-up>
            <ArrowUpIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.panUp}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.pan?.(0, 5)} data-pdmux-pan-down>
            <ArrowDownIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.panDown}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        {/if}
        {#if compact && actions.canScrollback}
          <DropdownMenu.Item onSelect={actions.toggleScrollback} data-pdmux-scrollback-menu>
            <ChevronsUpDownIcon class="mr-2 size-4" />
            {i18n.t.pdmux.pane.scrollback}
          </DropdownMenu.Item>
        {/if}
        {#if !standalone}
        <DropdownMenu.Item onSelect={actions.detach} data-pdmux-detach>
          <ExternalLinkIcon class="mr-2 size-4" />
          {i18n.t.pdmux.pane.detach}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {/if}
        {#if actions.terminate}
          <DropdownMenu.Item class="text-destructive focus:text-destructive" onSelect={actions.terminate} data-pdmux-terminate>
            <SquareIcon class="mr-2 size-4" />{i18n.t.pdmux.pane.terminate}
          </DropdownMenu.Item>
        {/if}
        {#if !standalone}
        <DropdownMenu.Item class="text-destructive focus:text-destructive" onSelect={actions.close} data-pdmux-close>
          <XIcon class="mr-2 size-4" />
          {i18n.t.pdmux.pane.close}
        </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {/if}
  </span>
</Tooltip.Provider>
