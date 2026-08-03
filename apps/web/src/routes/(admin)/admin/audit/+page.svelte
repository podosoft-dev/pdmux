<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "$lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarFilter, type ToolbarSearchField } from "$lib/components/table-toolbar.svelte";
  import { toast } from "svelte-sonner";
  import { getI18n, fmt, formatDateTime } from "$lib/i18n";

  const i18n = getI18n();
  type Entry = {
    id: string;
    action: string;
    actorId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    targetLabel: string | null;
    ip: string | null;
    createdAt: string;
  };

  let entries = $state<Entry[]>([]);
  let page = $state(1);
  let sort = $state<SortState | null>({ key: "createdAt", dir: "desc" });
  let search = $state("");
  let appliedSearch = $state("");
  let filterValues = $state<Record<string, string>>({ action: "" });
  let appliedFilters = $state<Record<string, string>>({ action: "" });
  let searchField = $state("actor");
  let appliedSearchField = $state("actor");

  const columns = $derived<DataTableColumn<Entry>[]>([
    { key: "createdAt", label: i18n.t.audit.when, sortable: true, class: "whitespace-nowrap" },
    { key: "actor", label: i18n.t.audit.actor, sortable: true, value: (e) => e.actorName ?? e.actorEmail },
    { key: "action", label: i18n.t.audit.action, sortable: true },
    { key: "target", label: i18n.t.audit.target, sortable: true, value: (e) => e.targetLabel },
    { key: "ip", label: i18n.t.audit.ip, sortable: true },
  ]);

  const actions = $derived([...new Set(entries.map((e) => e.action))].sort());
  const filters = $derived<ToolbarFilter[]>([
    {
      key: "action",
      label: i18n.t.audit.action,
      options: [{ value: "", label: i18n.t.toolbar.all }, ...actions.map((a) => ({ value: a, label: a }))],
    },
  ]);

  const searchFields = $derived<ToolbarSearchField[]>([
    { value: "actor", label: i18n.t.audit.actor },
    { value: "target", label: i18n.t.audit.target },
  ]);

  const filtered = $derived(
    entries.filter((e) => {
      if (appliedFilters.action && e.action !== appliedFilters.action) return false;
      if (appliedSearch) {
        const hay = (
          appliedSearchField === "target"
            ? (e.targetLabel ?? "")
            : `${e.actorName ?? ""} ${e.actorEmail ?? ""}`
        ).toLowerCase();
        if (!hay.includes(appliedSearch.toLowerCase())) return false;
      }
      return true;
    }),
  );

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/audit-logs");
      if (!res.ok) throw new Error();
      entries = (await res.json()) as Entry[];
    } catch {
      toast.error(i18n.t.audit.loadFailed);
    }
  }

  $effect(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4">
  <h1 class="text-2xl font-semibold">{i18n.t.audit.title}</h1>

  <TableToolbar
    {filters}
    bind:filterValues
    {searchFields}
    bind:searchField
    bind:search
    filterHeading={i18n.t.toolbar.filter}
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={() => { appliedSearch = search; appliedSearchField = searchField; appliedFilters = { ...filterValues }; page = 1; }}
  />

  <DataTable
    {columns}
    rows={filtered}
    getKey={(e) => e.id}
    empty={i18n.t.audit.empty}
    bind:sort
    bind:page
    perPage={DEFAULT_PAGE_SIZE}
    label={fmt(i18n.t.audit.total, { count: filtered.length })}
  >
    {#snippet row(e)}
      <Table.Cell class="text-muted-foreground whitespace-nowrap">{formatDateTime(e.createdAt)}</Table.Cell>
      <Table.Cell>
        {#if e.actorName || e.actorEmail}
          <div class="font-medium">{e.actorName ?? e.actorEmail}</div>
          {#if e.actorName && e.actorEmail}<div class="text-muted-foreground text-xs">{e.actorEmail}</div>{/if}
        {:else}
          <span class="text-muted-foreground">—</span>
        {/if}
      </Table.Cell>
      <Table.Cell><Badge variant="secondary" class="font-mono text-xs">{e.action}</Badge></Table.Cell>
      <Table.Cell class="max-w-xs truncate">{e.targetLabel ?? "—"}</Table.Cell>
      <Table.Cell class="text-muted-foreground">{e.ip ?? "—"}</Table.Cell>
    {/snippet}
  </DataTable>
</div>
