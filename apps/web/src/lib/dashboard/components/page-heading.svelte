<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import DashboardBack from "./dashboard-back.svelte";
  import InfoHint from "./info-hint.svelte";
  import { localDesktopPage, desktopSettingsTab } from "#lib/desktop/settings-navigation.js";
  let { title, help, testId, children }: { title: string; help?: string; testId?: string; children?: Snippet } = $props();
  const embedded = $derived(localDesktopPage(page.data) && desktopSettingsTab(page.url.pathname, page.url.searchParams) !== null);
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
