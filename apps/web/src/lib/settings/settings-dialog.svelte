<script lang="ts">
  import { untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { SvelteSet } from "svelte/reactivity";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ServerIcon from "@lucide/svelte/icons/server";
  import SlidersIcon from "@lucide/svelte/icons/sliders-horizontal";
  import KeyIcon from "@lucide/svelte/icons/key-round";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import WrenchIcon from "@lucide/svelte/icons/wrench";
  import XIcon from "@lucide/svelte/icons/x";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import { getI18n } from "#lib/i18n/index.js";
  import TerminalSettings from "#lib/desktop/terminal-settings.svelte";
  import GeneralSettings from "./general-settings.svelte";
  import AdvancedSettings from "./advanced-settings.svelte";
  import HostsPanel from "./panels/hosts.svelte";
  import HostPanel from "./panels/host.svelte";
  import FleetPanel from "./panels/fleet.svelte";
  import AccessPanel from "./panels/access.svelte";
  import ConnectionPanel from "./panels/connection.svelte";
  import { useSettings, type SettingsTab } from "./settings-state.svelte.js";
  import { fleetPanelData, hostPanelData, settingsRead } from "./settings-data.js";
  import type { SettingsShellData, FleetPanelData, HostSettingsData, ConnectionPanelData } from "./types.js";

  let { data }: { data: SettingsShellData } = $props();
  const settings = useSettings()!;
  const i18n = getI18n();
  const visited = new SvelteSet<SettingsTab>();
  let fleetLocal = $state<FleetPanelData | null>(null);
  let fleetServer = $state<FleetPanelData | null>(null);
  let host = $state<HostSettingsData | null>(null);
  let connection = $state<ConnectionPanelData | null>(null);
  let failed = $state(false);
  let saveFailed = $state(false);
  let saved = $state(false);
  const items = $derived([
    { id: "general" as const, label: i18n.t.desktop.preferences.general, icon: SettingsIcon },
    { id: "terminal" as const, label: i18n.t.desktop.preferences.terminal, icon: TerminalIcon },
    { id: "hosts" as const, label: i18n.t.dash.hosts.title, icon: ServerIcon },
    { id: "fleet" as const, label: i18n.t.dash.fleet.title, icon: SlidersIcon },
    { id: "access" as const, label: i18n.t.dash.mcpTokens.title, icon: KeyIcon },
    ...(data.desktopStatus.local ? [
      { id: "connection" as const, label: i18n.t.desktop.title, icon: CloudIcon },
      { id: "advanced" as const, label: i18n.t.desktop.preferences.advanced, icon: WrenchIcon },
    ] : []),
  ]);
  $effect(() => {
    if (settings.open && !items.some(item => item.id === settings.active)) settings.select("general");
    if (!data.desktopStatus.local && settings.target !== "local") settings.target = "local";
  });
  $effect(() => {
    const key = `${data.desktopStatus.connected}:${data.desktopStatus.serverUrl}:${data.desktopStatus.scopeId}:${data.desktopStatus.user?.id}`;
    untrack(() => { if (fleetServer && key !== `${fleetServer.desktopStatus.connected}:${fleetServer.desktopStatus.serverUrl}:${fleetServer.desktopStatus.scopeId}:${fleetServer.desktopStatus.user?.id}`) fleetServer = null; });
  });

  $effect(() => {
    if (settings.open) {
      const active = settings.active;
      untrack(() => { visited.add(active); failed = false; saveFailed = false; saved = false; });
    } else untrack(() => { visited.clear(); fleetLocal = null; fleetServer = null; host = null; connection = null; });
  });
  $effect(() => {
    if (!settings.open || settings.active !== "fleet") return;
    const target = settings.target;
    const server = data.desktopStatus.serverUrl;
    const scope = data.desktopStatus.scopeId;
    const connected = data.desktopStatus.connected;
    const abort = new AbortController();
    untrack(() => {
      // Refuse cached server drafts after account/workspace changes.
      if (target === "server" && fleetServer && (fleetServer.desktopStatus.serverUrl !== server || fleetServer.desktopStatus.scopeId !== scope || fleetServer.desktopStatus.connected !== connected)) fleetServer = null;
      if (target === "local" ? fleetLocal : fleetServer) return;
      void fleetPanelData(data, target, abort.signal).then(value => { if (!abort.signal.aborted) { if (target === "server") fleetServer = value; else fleetLocal = value; } }).catch(() => { if (!abort.signal.aborted) failed = true; });
    });
    return () => abort.abort();
  });
  $effect(() => {
    const id = settings.hostId;
    if (!settings.open || settings.active !== "hosts" || !id) return;
    const abort = new AbortController();
    untrack(() => { host = null; void hostPanelData(id, abort.signal).then(value => { if (!abort.signal.aborted) host = value; }).catch(() => { if (!abort.signal.aborted) failed = true; }); });
    return () => abort.abort();
  });
  async function refreshConnection(): Promise<void> {
    const status = await settingsRead<ConnectionPanelData["status"]>("/desktop/status");
    const agents = await settingsRead<ConnectionPanelData["agents"]>("/desktop/agents");
    connection = { status, agents };
    if (status.connected !== data.desktopStatus.connected || status.serverUrl !== data.desktopStatus.serverUrl || status.scopeId !== data.desktopStatus.scopeId) {
      fleetServer = null;
      await invalidateAll();
    }
  }
  $effect(() => {
    if (settings.open && settings.active === "connection") untrack(() => { void refreshConnection().catch(() => { failed = true; }); });
  });
  async function save(close: boolean): Promise<void> {
    saveFailed = false; saved = false;
    try {
      if (!await settings.save()) return;
      if (close) settings.close(); else saved = true;
    } catch { saveFailed = true; }
  }
</script>

<Dialog.Root open={settings.open} onOpenChange={open => { if (!open && !settings.busy) settings.close(); }}>
  <Dialog.Content showCloseButton={false} class="flex h-[min(52rem,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" data-testid="settings-dialog" onEscapeKeydown={event => { if (settings.busy) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()}>
    <Dialog.Header class="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
      <Dialog.Title>{i18n.t.settingsDialog.title}</Dialog.Title>
      <Dialog.Description class="sr-only">{i18n.t.settingsDialog.description}</Dialog.Description>
      <Button variant="ghost" size="icon" onclick={() => settings.close()} disabled={settings.busy} aria-label={i18n.t.settingsDialog.close} data-testid="settings-close"><XIcon class="size-4" /></Button>
    </Dialog.Header>
    <Tabs.Root orientation="vertical" value={settings.active} onValueChange={value => settings.select(value as SettingsTab)} class="grid min-h-0 flex-1 grid-cols-[3.5rem_minmax(0,1fr)] gap-0 sm:grid-cols-[12rem_minmax(0,1fr)]" data-testid="settings-tabs">
      <Tabs.List class="m-2 h-auto w-auto flex-col items-stretch justify-start gap-1 self-start" aria-label={i18n.t.settingsDialog.title}>
        {#each items as item (item.id)}<Tabs.Trigger value={item.id} class="min-h-11 flex-none justify-start" aria-label={item.label} title={item.label} data-testid={`settings-tab-${item.id}`}><item.icon class="size-4 shrink-0" /><span class="hidden whitespace-normal text-left sm:inline">{item.label}</span></Tabs.Trigger>{/each}
      </Tabs.List>
      <div class="min-h-0 min-w-0 overflow-hidden border-l">
        {#each items as item (item.id)}
          <Tabs.Content value={item.id} class="m-0 h-full min-h-0 min-w-0 overflow-y-auto data-[state=inactive]:hidden" data-testid={`settings-content-${item.id}`}>
            {#if visited.has(item.id)}
              {#if item.id === "general"}<GeneralSettings />
              {:else if item.id === "terminal"}<div class="p-4 sm:p-6"><TerminalSettings local={data.desktopStatus.local} /></div>
              {:else if item.id === "hosts"}
                {#if settings.hostId}<div class="px-4 pt-3"><Button variant="ghost" size="sm" onclick={() => settings.select("hosts")} data-testid="settings-hosts-back"><ArrowLeftIcon class="size-4" />{i18n.t.dash.hosts.title}</Button></div>{#if host}<HostPanel data={host} />{:else}{@render loading()}{/if}
                {:else}<HostsPanel {data} />{/if}
              {:else if item.id === "fleet"}
                {#each [fleetLocal, fleetServer] as panel, index (index)}{#if panel}<div class="h-full" hidden={(index === 1 ? "server" : "local") !== settings.target}><FleetPanel data={{ ...panel, desktopStatus: data.desktopStatus }} onTarget={target => { settings.target = target; }} /></div>{/if}{/each}
                {#if settings.target === "local" ? !fleetLocal : !fleetServer}{@render loading()}{/if}
              {:else if item.id === "access"}<AccessPanel />
              {:else if item.id === "connection"}{#if connection}<ConnectionPanel data={connection} refresh={refreshConnection} onConnectionChange={() => { fleetServer = null; }} />{:else}{@render loading()}{/if}
              {:else if item.id === "advanced"}<AdvancedSettings />{/if}
            {/if}
          </Tabs.Content>
        {/each}
      </div>
    </Tabs.Root>
    <Dialog.Footer class="mx-0 mb-0 shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t px-4 py-3" data-testid="settings-footer">
      {#if saveFailed}<p class="text-destructive w-full text-sm" role="alert">{i18n.t.settingsDialog.failed}</p>{:else if saved && !settings.dirty}<p class="text-muted-foreground me-auto text-sm" role="status">{i18n.t.settingsDialog.saved}</p>{/if}
      <Button variant="outline" onclick={() => settings.close()} disabled={settings.busy} data-testid="settings-cancel">{i18n.t.settingsDialog.cancel}</Button>
      <Button variant="outline" onclick={() => save(false)} disabled={!settings.dirty || !settings.valid || settings.busy} data-testid="settings-save">{settings.busy ? i18n.t.settingsDialog.saving : i18n.t.settingsDialog.save}</Button>
      <Button onclick={() => save(true)} disabled={!settings.valid || settings.busy} data-testid="settings-ok">{i18n.t.settingsDialog.ok}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
{#snippet loading()}<p class="p-6 text-sm" role={failed ? "alert" : "status"}>{failed ? i18n.t.settingsDialog.loadFailed : i18n.t.settingsDialog.loading}</p>{/snippet}
