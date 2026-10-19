<script lang="ts">
  import type { Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import InfoIcon from "@lucide/svelte/icons/info";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";

  let { label, text, children }: { label: string; text?: string; children?: Snippet } = $props();
  const i18n = getI18n();
  const coarse = new MediaQuery("pointer: coarse");
  let open = $state(false);
</script>

{#snippet explanation()}
  {#if children}{@render children()}{:else}{text}{/if}
{/snippet}

{#if coarse.current}
  <!-- Tooltips follow pointer exit; touch help needs an explicitly dismissible panel. -->
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} type="button" variant="ghost" size="icon" class="text-muted-foreground size-11 shrink-0 p-0" aria-label={fmt(i18n.t.dash.helpFor, { topic: label })} data-testid="info-hint">
          <InfoIcon class="size-4" aria-hidden="true" />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content side="bottom" sideOffset={4} class="bg-foreground text-background w-fit max-w-[min(24rem,calc(100vw-2rem))] border-0 p-3 text-xs leading-relaxed whitespace-pre-line" onOpenAutoFocus={(event) => event.preventDefault()} data-testid="info-hint-content">
      {@render explanation()}
    </Popover.Content>
  </Popover.Root>
{:else}
<Tooltip.Provider delayDuration={200}>
  <Tooltip.Root bind:open disableCloseOnTriggerClick>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button {...props} type="button" variant="ghost" size="icon" class="text-muted-foreground size-6 shrink-0 p-0" aria-label={fmt(i18n.t.dash.helpFor, { topic: label })} aria-expanded={open} data-testid="info-hint" onclick={() => (open = !open)}>
          <InfoIcon class="size-4" aria-hidden="true" />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" sideOffset={4} class="max-w-[min(24rem,calc(100vw-2rem))] text-left leading-relaxed whitespace-pre-line" data-testid="info-hint-content">
      {@render explanation()}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
{/if}
