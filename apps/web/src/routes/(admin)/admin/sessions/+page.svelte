<script lang="ts">
  import { untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import { toast } from "svelte-sonner";
  import { api } from "#lib/api.js";
  import { KeysetPages, listAdminSessions, revokeAdminSession, type AdminSession } from "#lib/admin/sessions.js";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";
  import { deviceLabel } from "#lib/device-label.js";

  const i18n = getI18n();
  const PAGE_SIZE = DEFAULT_PAGE_SIZE;
  // The API pages newest first by keyset, so the order is fixed rather than sortable.
  const sort: SortState = { key: "createdAt", dir: "desc" };
  const pages = new KeysetPages();

  let rows = $state<AdminSession[]>([]);
  let total = $state(0);
  let pagerTotal = $state(0);
  let page = $state(1);
  let loading = $state(false);
  let busy = $state(false);
  let search = $state("");
  let appliedSearch = $state("");
  let searchField = $state("user");
  let latestRequest = 0;
  let shownPage = 1;

  const columns = $derived<DataTableColumn<AdminSession>[]>([
    { key: "user", label: i18n.t.adminSessions.user },
    { key: "device", label: i18n.t.adminSessions.device },
    { key: "ip", label: i18n.t.adminSessions.ip },
    { key: "createdAt", label: i18n.t.adminSessions.since },
    { key: "expiresAt", label: i18n.t.adminSessions.expires },
    { key: "actions", label: "", class: "w-10" },
  ]);

  const searchFields = $derived<ToolbarSearchField[]>([{ value: "user", label: i18n.t.adminSessions.user }]);

  // Loads one page; a newer request supersedes any that is still in flight.
  async function load(target: number): Promise<void> {
    const cursor = pages.cursorFor(target);
    if (cursor === undefined) return;
    const request = ++latestRequest;
    loading = true;
    try {
      const result = await listAdminSessions(api, { limit: PAGE_SIZE, cursor, search: appliedSearch });
      if (request !== latestRequest) return;
      // A revoke can empty the last page; show the one before it instead.
      if (result.items.length === 0 && target > 1) return load(target - 1);
      pages.record(target, result.nextCursor);
      rows = result.items;
      total = result.total;
      pagerTotal = pages.pagerTotal(result.total, PAGE_SIZE);
      page = shownPage = target;
    } catch {
      if (request !== latestRequest) return;
      page = shownPage;
      toast.error(i18n.t.adminSessions.loadFailed);
    } finally {
      if (request === latestRequest) loading = false;
    }
  }

  function applySearch(): void {
    appliedSearch = search;
    pages.reset();
    void load(1);
  }

  async function revoke(row: AdminSession): Promise<void> {
    busy = true;
    try {
      await revokeAdminSession(api, row.id);
      toast.success(i18n.t.adminSessions.revoked);
      await load(page);
    } catch {
      toast.error(i18n.t.adminSessions.revokeFailed);
    } finally {
      busy = false;
    }
  }

  async function revokeAll(row: AdminSession): Promise<void> {
    busy = true;
    const { error } = await api.auth.admin.revokeUserSessions({ userId: row.userId });
    busy = false;
    if (error) return void toast.error(i18n.t.adminSessions.revokeFailed);
    toast.success(i18n.t.adminSessions.allRevoked);
    await load(page);
  }

  $effect(() => {
    untrack(() => void load(1));
  });
</script>

<div class="flex flex-col gap-4">
  <h1 class="text-2xl font-semibold">{i18n.t.adminSessions.title}</h1>

  <TableToolbar
    {searchFields}
    bind:searchField
    bind:search
    searchPlaceholder={i18n.t.adminSessions.searchPlaceholder}
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={applySearch}
  />

  <DataTable
    {columns}
    {rows}
    getKey={(r) => r.id}
    empty={loading ? "…" : i18n.t.adminSessions.empty}
    ariaLabel={i18n.t.adminSessions.title}
    {sort}
    manualSort
    manualPagination
    bind:page
    perPage={PAGE_SIZE}
    total={pagerTotal}
    label={fmt(i18n.t.adminSessions.total, { count: total })}
    onChange={(state) => void load(state.page)}
  >
    {#snippet row(r)}
      <Table.Cell>
        <div class="flex items-center gap-2">
          <div class="font-medium">{r.userName}</div>
          {#if r.impersonatedBy}<Badge variant="outline">{i18n.t.adminSessions.impersonated}</Badge>{/if}
        </div>
        <div class="text-muted-foreground text-xs">{r.userEmail}</div>
      </Table.Cell>
      <Table.Cell class="max-w-xs truncate" title={r.userAgent ?? ""}>{deviceLabel(r.userAgent) ?? r.userAgent ?? i18n.t.adminSessions.unknown}</Table.Cell>
      <Table.Cell class="text-muted-foreground">{r.ipAddress ?? "—"}</Table.Cell>
      <Table.Cell class="text-muted-foreground">{formatDateTime(r.createdAt)}</Table.Cell>
      <Table.Cell class="text-muted-foreground">{formatDateTime(r.expiresAt)}</Table.Cell>
      <Table.Cell>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon" disabled={busy}><EllipsisIcon class="size-4" /></Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onSelect={() => revoke(r)}>{i18n.t.adminSessions.revoke}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => revokeAll(r)}>{i18n.t.adminSessions.revokeAll}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Table.Cell>
    {/snippet}
  </DataTable>
</div>
