<script lang="ts">
  /**
   * A ⓘ beside a label that explains the setting on hover, focus or tap.
   *
   * For settings whose meaning a label cannot carry and a paragraph under every field would
   * bury. ⚠ A TAP OPENS IT TOO: a plain tooltip answers hover and focus only, and a phone has no
   * hover — so the button toggles it, and the text is also its accessible name.
   */
  import InfoIcon from "@lucide/svelte/icons/info";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";

  let { text, testId }: { text: string; testId?: string } = $props();
  let open = $state(false);
</script>

<Tooltip.Provider delayDuration={150}>
  <Tooltip.Root bind:open>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -my-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle outline-none focus-visible:ring-2"
          aria-label={text}
          data-testid={testId}
          onclick={() => (open = !open)}
        >
          <InfoIcon class="size-3.5" aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content class="max-w-72 text-xs leading-relaxed">{text}</Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
