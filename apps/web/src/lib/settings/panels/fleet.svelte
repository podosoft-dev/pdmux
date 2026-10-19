<script lang="ts">
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import FleetSettingsForm from "#lib/dashboard/components/fleet-settings-form.svelte";
  import { useShellState } from "#lib/dashboard/shell-state.svelte.ts";
  import PageHeading from "#lib/dashboard/components/page-heading.svelte";
  import InfoHint from "#lib/dashboard/components/info-hint.svelte";

  import type { FleetPanelData } from "../types.js";
  import { useSettings } from "../settings-state.svelte.js";
  let { data, onTarget }: { data: FleetPanelData; onTarget: (target: "local" | "server") => void } = $props();
  const settings = useSettings();
  const i18n = getI18n();
  const shell = useShellState();
  const localHosts = $derived(shell.feed.hosts.filter(host => host.origin?.kind !== "server"));
</script>


<div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6" data-testid="fleet-settings-panel" data-pdmux-region="page">
  <PageHeading title={i18n.t.dash.fleet.title} testId="fleet-settings-title" help={`${i18n.t.dash.fleet.subtitle}\n${data.desktopStatus.local ? i18n.t.desktop.settings.separate : i18n.t.dash.fleet.scopeNote}`} />
  {#if data.desktopStatus.local}
    <Tabs.Root class="contents" value={data.settingsTarget} onValueChange={value => onTarget(value === "server" ? "server" : "local")}>
      <Tabs.List aria-label={i18n.t.desktop.settings.target}>
        <Tabs.Trigger value="local" data-testid="settings-target-local">{i18n.t.desktop.settings.local}</Tabs.Trigger>
        <Tabs.Trigger value="server" disabled={!data.desktopStatus.connected} data-testid="settings-target-server">{i18n.t.desktop.settings.server}</Tabs.Trigger>
      </Tabs.List>
    <Tabs.Content value={data.settingsTarget} class="contents">
      {@render settingsContent()}
    </Tabs.Content>
    </Tabs.Root>
  {:else}
    {@render settingsContent()}
  {/if}
</div>

{#snippet settingsContent()}
  {#if data.desktopStatus.local}
    <div class="text-muted-foreground space-y-1 text-sm" data-testid="settings-target-description">
      <div class="flex items-center gap-1"><span>{data.settingsTarget === "server" ? i18n.t.desktop.settings.server : i18n.t.desktop.settings.local}</span><InfoHint label={i18n.t.desktop.settings.target} text={data.settingsTarget === "server" ? i18n.t.desktop.settings.serverDescription : i18n.t.desktop.settings.localDescription} /></div>
      {#if data.settingsTarget === "server"}<p class="break-all">{data.desktopStatus.serverUrl} · {data.desktopStatus.organizations?.find(organization => organization.id === data.desktopStatus.scopeId)?.name ?? i18n.t.desktop.personal}</p>{/if}
      {#if !data.desktopStatus.connected}<p>{i18n.t.desktop.settings.signInRequired} <Button onclick={() => settings?.show("connection")} variant="link" size="sm" class="h-auto p-0">{i18n.t.desktop.title}</Button></p>{/if}
    </div>
  {/if}
  {#if data.settingsTarget === "server" && !data.desktopStatus.connected}
    <Card.Root class="shrink-0"><Card.Content class="py-6"><p>{i18n.t.desktop.settings.signInRequired}</p><Button onclick={() => settings?.show("connection")} class="mt-3">{i18n.t.desktop.title}</Button></Card.Content></Card.Root>
  {:else}
    {#key `${data.settingsTarget}:${data.desktopStatus.serverUrl ?? ""}:${data.desktopStatus.scopeId ?? ""}`}
      <FleetSettingsForm data={data.settingsData} target={data.settingsTarget} serverFeatures={!data.desktopStatus.local || data.settingsTarget === "server"} hosts={data.settingsTarget === "server" ? data.settingsHosts : localHosts} />
    {/key}
  {/if}
{/snippet}
