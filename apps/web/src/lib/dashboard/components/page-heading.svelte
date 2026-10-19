<script lang="ts">
  import type { Snippet } from "svelte";
  import { useSettings } from "#lib/settings/settings-state.svelte.js";
  import DashboardBack from "./dashboard-back.svelte";
  import InfoHint from "./info-hint.svelte";
  let { title, help, testId, children }: { title: string; help?: string; testId?: string; children?: Snippet } = $props();
  const settings = useSettings();
  const embedded = $derived(settings?.open ?? false);
</script>

<div class="flex shrink-0 flex-wrap items-center justify-between gap-3">
  <div class="flex min-w-0 items-center gap-3">
    {#if !embedded}<DashboardBack />{/if}
    <div class="flex min-w-0 items-center gap-1">
      <svelte:element this={embedded ? "h2" : "h1"} class="min-w-0 break-words text-2xl font-semibold" data-testid={testId}>{title}</svelte:element>
      {#if help}<InfoHint label={title} text={help} />{/if}
    </div>
  </div>
  {#if children}{@render children()}{/if}
</div>
