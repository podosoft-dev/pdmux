<script lang="ts">
  import { onMount } from "svelte";
  import type { SyncConflict } from "@pdmux/desktop-protocol";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable from "#lib/components/data-table.svelte";
  import { getI18n } from "#lib/i18n/index.js";
  import { desktopConnection } from "#lib/desktop.js";
  import LocalHostCard from "#lib/desktop/local-host-card.svelte";
  import PageHeading from "#lib/dashboard/components/page-heading.svelte";
  import InfoHint from "#lib/dashboard/components/info-hint.svelte";
  import type { ConnectionPanelData } from "../types.js";
  let { data, refresh, onConnectionChange }: { data: ConnectionPanelData; refresh: () => Promise<void>; onConnectionChange: () => void } = $props();
  const i18n = getI18n();
  let server = $state(""); let code = $state(""); let busy = $state(false); let pending = $state(false); let failed = $state(false);
  let conflict = $state<SyncConflict | null>(null);
  const columns = $derived([{ key: "key", label: i18n.t.desktop.item }, { key: "action", label: i18n.t.desktop.review }]);
  onMount(() => { server = data.status.serverUrl ?? ""; const timer = setInterval(() => { void refresh(); }, 5_000); return () => clearInterval(timer); });
  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true; failed = false;
    try { await action(); await refresh(); } catch { failed = true; } finally { busy = false; }
  }
  async function change(action: () => Promise<unknown>): Promise<void> {
    onConnectionChange();
    await run(action);
  }
  async function connect(): Promise<void> { const bridge = desktopConnection(); if (bridge) { await bridge.connect(server); pending = true; } }
  async function authenticate(): Promise<void> { const bridge = desktopConnection(); if (bridge) { await bridge.authenticate(code); pending = false; code = ""; } }
  async function download(file: string): Promise<void> {
    const response = await fetch(`/api/desktop/agents/${data.agents?.version}/prefetch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) });
    if (!response.ok) throw new Error("DESKTOP_AGENT_DOWNLOAD_FAILED");
  }
  async function resolve(choice: "local" | "server"): Promise<void> {
    if (!conflict) return;
    const response = await fetch("/api/desktop/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: conflict.key, choice }) });
    if (!response.ok) throw new Error("DESKTOP_SYNC_FAILED"); conflict = null;
  }
</script>
<div class="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-6" data-pdmux-region="page" data-testid="desktop-connection">
  <PageHeading title={i18n.t.desktop.title} help={i18n.t.desktop.localDescription} />
  <LocalHostCard />
  {#if data.status.local}
    <Card.Root class="shrink-0">
      <Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.server}<InfoHint label={i18n.t.desktop.server} text={`${i18n.t.desktop.sharing}\n${i18n.t.desktop.offlineCache}`} /></Card.Title></Card.Header>
      <Card.Content class="space-y-4">
        <p class="text-sm" role="status">{data.status.connected ? (data.status.bridgeConnected ? i18n.t.desktop.connected : i18n.t.desktop.reconnecting) : i18n.t.desktop.localOnly}</p>
        <p class="text-muted-foreground text-sm">{i18n.t.desktop.shareSummary}</p>
        {#if data.status.serverUrl}<p class="text-muted-foreground break-all text-sm">{data.status.serverUrl} · {data.status.scopeId}</p>{/if}
        {#if data.status.connected && data.status.organizations?.length}
          <div class="grid max-w-xl gap-2"><Label for="desktop-workspace">{i18n.t.desktop.workspace}</Label>
            <Select.Root type="single" value={data.status.scopeId?.startsWith("personal:") ? "personal" : data.status.scopeId ?? "personal"} onValueChange={value => change(async () => { await desktopConnection()?.workspace(value === "personal" ? null : value); })}>
              <Select.Trigger id="desktop-workspace" disabled={busy}>{data.status.organizations.find(row => row.id === data.status.scopeId)?.name ?? i18n.t.desktop.personal}</Select.Trigger>
              <Select.Content><Select.Item value="personal">{i18n.t.desktop.personal}</Select.Item>{#each data.status.organizations as organization (organization.id)}<Select.Item value={organization.id}>{organization.name}</Select.Item>{/each}</Select.Content>
            </Select.Root>
          </div>
        {/if}
        {#if data.status.lastSync}<p class="text-muted-foreground text-xs">{i18n.t.desktop.lastSync}: {data.status.lastSync}</p>{/if}
        <div class="grid max-w-xl gap-2"><Label for="desktop-server">{i18n.t.desktop.serverUrl}</Label><Input id="desktop-server" type="url" bind:value={server} placeholder="https://example.com" disabled={busy} /></div>
        <div class="flex flex-wrap gap-2">
          <Button onclick={() => change(connect)} disabled={busy || !server}>{i18n.t.desktop.signIn}</Button>
          {#if data.status.connected}<Button variant="outline" onclick={() => change(async () => { await desktopConnection()?.disconnect(); pending = false; })} disabled={busy}>{i18n.t.desktop.signOut}</Button>{/if}
        </div>
        {#if pending}
          <p class="text-muted-foreground text-sm">{i18n.t.desktop.browserPending}</p>
          <div class="grid max-w-xl gap-2"><Label for="desktop-code">{i18n.t.desktop.code}</Label><Input id="desktop-code" bind:value={code} autocomplete="off" /></div>
          <Button variant="outline" disabled={busy || code.length < 32} onclick={() => change(authenticate)}>{i18n.t.desktop.complete}</Button>
        {/if}
        {#if failed || data.status.error}<p class="text-destructive text-sm" role="alert">{i18n.t.desktop.failed}</p>{/if}
      </Card.Content>
    </Card.Root>
    <Card.Root class="shrink-0">
      <Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.conflicts}<InfoHint label={i18n.t.desktop.conflicts} text={i18n.t.desktop.conflictDescription} /></Card.Title></Card.Header>
      <Card.Content>
        <DataTable {columns} rows={data.status.conflicts ?? []} empty={i18n.t.desktop.noConflicts}>
          {#snippet row(item)}<Table.Cell class="max-w-xs truncate">{item.key}</Table.Cell><Table.Cell><Button size="sm" variant="outline" onclick={() => { conflict = item; }}>{i18n.t.desktop.review}</Button></Table.Cell>{/snippet}
        </DataTable>
      </Card.Content>
    </Card.Root>
    {#if data.agents}
      <Card.Root class="shrink-0"><Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.agents}<InfoHint label={i18n.t.desktop.agents} text={i18n.t.desktop.agentDescription} /></Card.Title></Card.Header><Card.Content>
        <DataTable columns={[{ key: "file", label: i18n.t.desktop.item }, { key: "available", label: i18n.t.desktop.download }]} rows={data.agents.artifacts}>
          {#snippet row(item)}<Table.Cell class="text-xs">{item.file}</Table.Cell><Table.Cell>{#if item.available}<span class="text-muted-foreground text-sm">{i18n.t.desktop.available}</span>{:else}<Button size="sm" variant="outline" disabled={busy} onclick={() => run(() => download(item.file))}>{i18n.t.desktop.download}</Button>{/if}</Table.Cell>{/snippet}
        </DataTable>
      </Card.Content></Card.Root>
    {/if}
  {:else}<p>{i18n.t.desktop.desktopRequired}</p>{/if}
</div>
<Dialog.Root open={Boolean(conflict)} onOpenChange={open => { if (!open) conflict = null; }}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
    <Dialog.Header><Dialog.Title>{i18n.t.desktop.review}</Dialog.Title><Dialog.Description>{conflict?.key}</Dialog.Description></Dialog.Header>
    <div class="grid min-w-0 gap-4 sm:grid-cols-2">
      <section class="min-w-0"><h2 class="mb-2 text-sm font-medium">{i18n.t.desktop.localValue}</h2><pre class="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs">{JSON.stringify(conflict?.local.value, null, 2)}</pre></section>
      <section class="min-w-0"><h2 class="mb-2 text-sm font-medium">{i18n.t.desktop.serverValue}</h2><pre class="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs">{JSON.stringify(conflict?.server.value, null, 2)}</pre></section>
    </div>
    <Dialog.Footer><Button variant="outline" disabled={busy} onclick={() => run(() => resolve("server"))}>{i18n.t.desktop.useServer}</Button><Button disabled={busy} onclick={() => run(() => resolve("local"))}>{i18n.t.desktop.useLocal}</Button></Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
