<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { getI18n } from "#lib/i18n/index.js";

  const i18n = getI18n();
  const coarse = new MediaQuery("pointer: coarse");
  const descriptionId = $props.id();
</script>

{#if coarse.current}
  <Popover.Root>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} type="button" variant="ghost" size="icon" class="pdmux-pane-ephemeral size-6 p-0" title="" aria-label={i18n.t.pdmux.pane.ephemeral} data-testid="terminal-warning">
          <TriangleAlertIcon aria-hidden="true" />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content side="bottom" sideOffset={6} class="w-fit max-w-[min(20rem,calc(100vw-2rem))] text-sm leading-relaxed" onOpenAutoFocus={(event) => event.preventDefault()} data-testid="terminal-warning-help">
      {i18n.t.pdmux.pane.ephemeralDescription}
    </Popover.Content>
  </Popover.Root>
{:else}
  <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button {...props} type="button" variant="ghost" size="icon" class="pdmux-pane-ephemeral size-4 p-0" title="" aria-label={i18n.t.pdmux.pane.ephemeral} aria-describedby={descriptionId} data-testid="terminal-warning">
            <TriangleAlertIcon aria-hidden="true" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom" sideOffset={6} class="max-w-xs text-left leading-relaxed whitespace-normal" data-testid="terminal-warning-help">
        <span id={descriptionId} role="tooltip">{i18n.t.pdmux.pane.ephemeralDescription}</span>
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
