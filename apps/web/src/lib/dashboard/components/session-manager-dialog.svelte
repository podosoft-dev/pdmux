<script lang="ts">
  import { untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable, { type DataTableColumn } from "#lib/components/data-table.svelte";
  import TableToolbar from "#lib/components/table-toolbar.svelte";
  import { getI18n } from "#lib/i18n/index.js";
  import { FleetFeed } from "../fleet-feed.svelte.js";
  import { managedSessions, type ManagedSession } from "../session-manager.js";
  import SessionRenameDialog from "./session-rename-dialog.svelte";
  import SessionTerminateDialog from "./session-terminate-dialog.svelte";

  let { open = $bindable(false), onChanged }: {
    open?: boolean;
    /** `renamed` is set when the change was a rename, so open slots can follow it. */
    onChanged: (renamed?: { hostId: string; sessionId?: string; tmuxId?: string; name: string }) => Promise<void>;
  } = $props();
  const i18n = getI18n();
  const feed = new FleetFeed({ includeHistory: false });
  let selectedKey = $state<string | null>(null);
  let search = $state("");
  let query = $state("");
  let loading = $state(false);
  const failed = $derived(feed.error !== null);
  let renameOpen = $state(false);
  let terminateOpen = $state(false);
  const rows = $derived(managedSessions(feed.hosts, query));
  const selected = $derived(rows.find(row => row.key === selectedKey) ?? null);
  const actionable = $derived(!failed && selected?.online === true && Boolean(selected.slot.sessionId || selected.slot.tmuxId));
  const wide = new MediaQuery("min-width: 640px");
  const desktop = new MediaQuery("min-width: 768px");
  // Match the rendered cells and footer colspan to the visible columns. Hiding
  // cells with CSS leaves phantom columns in a fixed-layout table on phones.
  const columns = $derived<DataTableColumn<ManagedSession>[]>([
    { key: "name", label: i18n.t.sessionRename.name, sortable: true, class: "min-w-0" },
    ...(wide.current ? [{ key: "hostName", label: i18n.t.sessionManager.host, sortable: true }] : []),
    ...(desktop.current ? [{ key: "backend", label: i18n.t.sessionManager.backend, sortable: true }] : []),
    ...(wide.current ? [{ key: "attached", label: i18n.t.sessionManager.attached, sortable: true, class: "w-20 text-right" }] : []),
  ]);
  $effect(() => {
    if (!open) return;
    untrack(() => { selectedKey = null; search = ""; query = ""; feed.hosts = []; feed.start(); });
    return () => feed.stop();
  });
  async function refresh(): Promise<void> {
    loading = true;
    try { await feed.refresh(); }
    finally { loading = false; }
  }
  async function changed(renamed?: { hostId: string; sessionId?: string; tmuxId?: string; name: string }): Promise<void> {
    await refresh();
    await onChanged(renamed);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden sm:max-w-3xl" data-testid="session-manager-dialog">
    <Dialog.Header>
      <Dialog.Title>{i18n.t.sessionManager.title}</Dialog.Title>
      <Dialog.Description>{i18n.t.sessionManager.description}</Dialog.Description>
    </Dialog.Header>
    <div class="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto" data-testid="session-manager-body">
      <TableToolbar searchFields={[{ value: "all", label: i18n.t.sessionManager.searchBy }]} searchField="all" bind:search searchPlaceholder={i18n.t.sessionManager.searchPlaceholder} searchHeading={i18n.t.sessionManager.search} searchButton={i18n.t.sessionManager.search} onSearch={() => { query = search; selectedKey = null; }} />
      <div class="flex items-center justify-between gap-2">
        <p class="text-muted-foreground text-sm">{i18n.t.sessionManager.count.replace("{count}", String(rows.length))}</p>
        <Button variant="outline" size="sm" disabled={loading} onclick={refresh} data-testid="session-manager-refresh"><RefreshCwIcon class="size-4" />{i18n.t.sessionManager.refresh}</Button>
      </div>
      {#if failed}<p role="alert" class="text-destructive text-sm">{i18n.t.sessionManager.failed}</p>{/if}
      <div class="[&_table]:w-full [&_table]:table-fixed [&_[data-slot=pagination-content]]:flex-wrap">
      <DataTable {rows} {columns} getKey={row => row.key} empty={i18n.t.sessionManager.empty} ariaLabel={i18n.t.sessionManager.title} perPage={10}>
        {#snippet row(item, cells)}
          <Table.Cell class={cells.cellClass("name")}>
            <Button variant={selectedKey === item.key ? "secondary" : "ghost"} class="h-auto min-h-11 w-full min-w-0 max-w-[28rem] justify-start px-2 text-left whitespace-normal" aria-pressed={selectedKey === item.key} onclick={() => selectedKey = item.key} data-testid="session-manager-row" data-host-id={item.hostId} data-session-id={item.slot.sessionId ?? item.slot.tmuxId}>
              <span class="min-w-0 break-all"><span class="block font-medium">{item.name}</span><span class="text-muted-foreground block text-xs sm:hidden">{item.hostName}</span><span class="text-muted-foreground block text-xs sm:hidden">{item.backend === "native" ? i18n.t.sessionManager.native : "tmux"} · {i18n.t.sessionManager.attached}: {item.attached}</span>{#if !item.online}<span class="text-muted-foreground block text-xs">{i18n.t.sessionManager.offline}</span>{/if}</span>
            </Button>
          </Table.Cell>
          {#if wide.current}<Table.Cell class={cells.cellClass("hostName")}><span class="block max-w-48 truncate" title={item.hostName}>{item.hostName}</span></Table.Cell>{/if}
          {#if desktop.current}<Table.Cell class={cells.cellClass("backend")}>{item.backend === "native" ? i18n.t.sessionManager.native : "tmux"}</Table.Cell>{/if}
          {#if wide.current}<Table.Cell class={cells.cellClass("attached")}>{item.attached}</Table.Cell>{/if}
        {/snippet}
      </DataTable>
      </div>
    </div>
    <div class="min-w-0 border-t pt-3">
      <p class="mb-3 min-w-0 break-all text-sm" data-testid="session-manager-selected">{selected ? `${selected.hostName} · ${selected.name}` : i18n.t.sessionManager.select}</p>
      {#if selected?.backend === "tmux" && !selected.slot.tmuxId}<p class="text-muted-foreground mb-3 text-sm">{i18n.t.sessionManager.legacy}</p>{/if}
      <Dialog.Footer class="flex-wrap">
        <Button variant="outline" onclick={() => open = false}>{i18n.t.sessionManager.close}</Button>
        <Button variant="outline" disabled={!actionable} onclick={() => renameOpen = true} data-testid="session-manager-rename">{i18n.t.sessionRename.title}</Button>
        <Button variant="destructive" disabled={!actionable} onclick={() => terminateOpen = true} data-testid="session-manager-terminate">{i18n.t.pdmux.pane.terminate}</Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
<SessionRenameDialog bind:open={renameOpen} slot={selected?.slot ?? null} onRenamed={(renamed) => changed(renamed)} />
<SessionTerminateDialog bind:open={terminateOpen} slot={selected?.slot ?? null} hostName={selected?.hostName} onTerminated={changed} />
