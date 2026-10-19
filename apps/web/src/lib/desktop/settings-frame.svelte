<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import DashboardBack from "#lib/dashboard/components/dashboard-back.svelte";
  import { getI18n } from "#lib/i18n/index.js";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ServerIcon from "@lucide/svelte/icons/server";
  import SlidersIcon from "@lucide/svelte/icons/sliders-horizontal";
  import KeyIcon from "@lucide/svelte/icons/key-round";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import WrenchIcon from "@lucide/svelte/icons/wrench";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import { desktopSettingsTab } from "./settings-navigation.js";
  let { children }: { children: Snippet } = $props();
  const i18n = getI18n();
  const active = $derived(desktopSettingsTab(page.url.pathname, page.url.searchParams) ?? "terminal");
  const items = $derived([
    { id: "general", href: "/preferences?tab=general", label: i18n.t.desktop.preferences.general, icon: SettingsIcon },
    { id: "terminal", href: "/preferences", label: i18n.t.desktop.preferences.terminal, icon: TerminalIcon },
    { id: "hosts", href: "/hosts", label: i18n.t.dash.hosts.title, icon: ServerIcon },
    { id: "fleet", href: "/settings", label: i18n.t.dash.fleet.title, icon: SlidersIcon },
    { id: "access", href: "/access", label: i18n.t.dash.mcpTokens.title, icon: KeyIcon },
    { id: "connection", href: "/connection", label: i18n.t.desktop.title, icon: CloudIcon },
    { id: "advanced", href: "/preferences?tab=advanced", label: i18n.t.desktop.preferences.advanced, icon: WrenchIcon },
  ]);
</script>

<div class="min-h-0 min-w-0 flex-col" data-pdmux-region="page" data-testid="desktop-settings">
  <header class="flex shrink-0 items-center gap-3 border-b p-4 sm:p-6"><DashboardBack /><h1 class="text-2xl font-semibold">{i18n.t.desktop.preferences.title}</h1></header>
  <Tabs.Root orientation="vertical" value={active} onValueChange={value => { const item = items.find(row => row.id === value); if (item) void goto(item.href); }} class="grid min-h-0 flex-1 grid-cols-[3.5rem_minmax(0,1fr)] gap-0 py-3 sm:grid-cols-[12rem_minmax(0,1fr)]" data-testid="desktop-settings-tabs">
    <Tabs.List class="mx-2 h-auto w-auto flex-col items-stretch justify-start gap-1 self-start" aria-label={i18n.t.desktop.preferences.title}>
      {#each items as item (item.id)}
        <Tabs.Trigger value={item.id} class="h-11 flex-none justify-start" aria-label={item.label} title={item.label} data-testid={`settings-tab-${item.id}`}><item.icon class="size-4" /><span class="hidden whitespace-normal text-left sm:inline">{item.label}</span></Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#each items as item (item.id)}
      <Tabs.Content value={item.id} class="m-0 flex min-h-0 min-w-0 overflow-hidden border-l [&>div]:min-w-0 [&>div]:flex-1 [&>div]:p-4" data-testid={`settings-content-${item.id}`}>
        {#if active === item.id}{@render children()}{/if}
      </Tabs.Content>
    {/each}
  </Tabs.Root>
</div>
