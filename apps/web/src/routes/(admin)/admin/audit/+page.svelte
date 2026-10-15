<script lang="ts">
  import { onMount } from "svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarFilter, type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import { toast } from "svelte-sonner";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";
  import {
    cursorForPage,
    emptyTrail,
    fetchAuditActions,
    fetchAuditLogPage,
    recordPage,
    trailCount,
    type AuditLogEntry,
    type AuditLogFilters,
    type AuditLogOrder,
  } from "#lib/audit-log.js";

  const i18n = getI18n();
  const PAGE_SIZE = DEFAULT_PAGE_SIZE;

  let entries = $state<AuditLogEntry[]>([]);
  let actions = $state<string[]>([]);
  let page = $state(1);
  let shownPage = $state(1);
  let trail = $state(emptyTrail());
  let sort = $state<SortState | null>({ key: "createdAt", dir: "desc" });
  let search = $state("");
  let searchField = $state("actor");
  let filterValues = $state<Record<string, string>>({ action: "" });
  let applied = $state<AuditLogFilters>({ action: "", actor: "", target: "" });
  let trailOrder: AuditLogOrder = "desc";
  let latestRequest = 0;

  // The server pages by time with a cursor, so time is the only sortable column.
  const columns = $derived<DataTableColumn<AuditLogEntry>[]>([
    { key: "createdAt", label: i18n.t.audit.when, sortable: true, class: "whitespace-nowrap" },
    { key: "actor", label: i18n.t.audit.actor },
    { key: "action", label: i18n.t.audit.action },
    { key: "target", label: i18n.t.audit.target },
    { key: "ip", label: i18n.t.audit.ip },
  ]);

  const actionOptions = $derived([...new Set([...actions, ...(applied.action ? [applied.action] : [])])].sort());
  const filters = $derived<ToolbarFilter[]>([
    {
      key: "action",
      label: i18n.t.audit.action,
      options: [{ value: "", label: i18n.t.toolbar.all }, ...actionOptions.map((a) => ({ value: a, label: a }))],
    },
  ]);

  const searchFields = $derived<ToolbarSearchField[]>([
    { value: "actor", label: i18n.t.audit.actor },
    { value: "target", label: i18n.t.audit.target },
  ]);

  const count = $derived(trailCount(trail, PAGE_SIZE));
  const first = $derived((shownPage - 1) * PAGE_SIZE + 1);
  const label = $derived(
    trail.end || entries.length === 0
      ? fmt(i18n.t.audit.total, { count })
      : fmt(i18n.t.audit.range, { from: first, to: first + entries.length - 1 }),
  );

  function currentOrder(): AuditLogOrder {
    return sort?.dir === "asc" ? "asc" : "desc";
  }

  async function load(target: number): Promise<void> {
    const cursor = cursorForPage(trail, target);
    if (cursor === undefined) {
      page = shownPage;
      return;
    }
    const request = ++latestRequest;
    try {
      const result = await fetchAuditLogPage(fetch, applied, trailOrder, cursor, PAGE_SIZE);
      if (request !== latestRequest) return;
      entries = result.entries;
      page = target;
      shownPage = target;
      trail = recordPage(trail, target, result.entries.length, result.nextCursor);
    } catch {
      if (request !== latestRequest) return;
      page = shownPage;
      toast.error(i18n.t.audit.loadFailed);
    }
  }

  function restart(): void {
    trailOrder = currentOrder();
    trail = emptyTrail();
    void load(1);
  }

  function applySearch(): void {
    const value = search.trim();
    applied = {
      action: filterValues.action ?? "",
      actor: searchField === "actor" ? value : "",
      target: searchField === "target" ? value : "",
    };
    restart();
  }

  function onTableChange(state: { page: number }): void {
    if (currentOrder() !== trailOrder) restart();
    else void load(state.page);
  }

  onMount(() => {
    restart();
    void fetchAuditActions(fetch).then((codes) => { actions = codes; }, () => undefined);
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
    searchPlaceholder={searchField === "target" ? i18n.t.audit.targetHint : i18n.t.audit.actorHint}
    filterHeading={i18n.t.toolbar.filter}
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={applySearch}
  />

  <DataTable
    {columns}
    rows={entries}
    getKey={(e) => e.id}
    empty={i18n.t.audit.empty}
    ariaLabel={i18n.t.audit.title}
    bind:sort
    manualSort
    bind:page
    perPage={PAGE_SIZE}
    total={count}
    manualPagination
    {label}
    onChange={onTableChange}
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
