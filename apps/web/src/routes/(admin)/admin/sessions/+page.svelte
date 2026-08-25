<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import { toast } from "svelte-sonner";
  import { api } from "#lib/api.js";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";
  import { deviceLabel } from "#lib/device-label.js";

  const i18n = getI18n();

  // better-auth has no "list all sessions" endpoint, so fan out listUserSessions
  // over a page of users and flatten. Bounded to USER_LIMIT users — adequate for a
  // starter admin view; paginate/scope further for large deployments.
  const USER_LIMIT = 50;
  type Row = {
    id: string;
    token: string;
    userId: string;
    userName: string;
    userEmail: string;
    userAgent?: string | null;
    ipAddress?: string | null;
    createdAt: string | Date;
    expiresAt?: string | Date | null;
    impersonatedBy?: string | null;
  };

  let rows = $state<Row[]>([]);
  let page = $state(1);
  // No default sort: keep the fan-out order so the newest session isn't required
  // to sit on page 1. Sorting is available by clicking a column header.
  let sort = $state<SortState | null>(null);
  let loading = $state(false);
  let busy = $state(false);
  let search = $state("");
  let appliedSearch = $state("");
  let searchField = $state("email");
  let appliedSearchField = $state("email");

  const columns = $derived<DataTableColumn<Row>[]>([
    { key: "user", label: i18n.t.adminSessions.user, sortable: true, value: (r) => r.userName },
    { key: "device", label: i18n.t.adminSessions.device, sortable: true, value: (r) => deviceLabel(r.userAgent) ?? r.userAgent ?? "" },
    { key: "ip", label: i18n.t.adminSessions.ip, sortable: true, value: (r) => r.ipAddress },
    { key: "createdAt", label: i18n.t.adminSessions.since, sortable: true },
    { key: "expiresAt", label: i18n.t.adminSessions.expires, sortable: true, value: (r) => (r.expiresAt ? new Date(r.expiresAt).getTime() : 0) },
    { key: "actions", label: "", class: "w-10" },
  ]);

  const searchFields = $derived<ToolbarSearchField[]>([
    { value: "email", label: i18n.t.users.email },
    { value: "name", label: i18n.t.users.name },
  ]);

  const filtered = $derived(
    rows.filter((r) => {
      if (!appliedSearch) return true;
      const hay = (appliedSearchField === "name" ? r.userName : r.userEmail).toLowerCase();
      return hay.includes(appliedSearch.toLowerCase());
    }),
  );

  async function load(): Promise<void> {
    loading = true;
    const { data, error } = await api.auth.admin.listUsers({ query: { limit: USER_LIMIT, offset: 0 } });
    if (error) {
      loading = false;
      toast.error(error.message ?? i18n.t.adminSessions.loadFailed);
      return;
    }
    const users = (data?.users ?? []) as Array<{ id: string; name: string; email: string }>;
    const perUser = await Promise.all(
      users.map(async (u) => {
        const { data: res } = await api.auth.admin.listUserSessions({ userId: u.id });
        const sessions = (res?.sessions ?? []) as Array<Omit<Row, "userId" | "userName" | "userEmail">>;
        return sessions.map((s) => ({ ...s, userId: u.id, userName: u.name, userEmail: u.email }));
      }),
    );
    rows = perUser.flat();
    loading = false;
  }

  async function act(promise: Promise<{ error?: { message?: string } | null }>, ok: string): Promise<void> {
    busy = true;
    const { error } = await promise;
    busy = false;
    if (error) toast.error(error.message ?? i18n.t.adminSessions.loadFailed);
    else {
      toast.success(ok);
      await load();
    }
  }

  const revoke = (row: Row) =>
    act(api.auth.admin.revokeUserSession({ sessionToken: row.token }), i18n.t.adminSessions.revoked);
  const revokeAll = (row: Row) =>
    act(api.auth.admin.revokeUserSessions({ userId: row.userId }), i18n.t.adminSessions.allRevoked);

  $effect(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4">
  <h1 class="text-2xl font-semibold">{i18n.t.adminSessions.title}</h1>

  <TableToolbar
    {searchFields}
    bind:searchField
    bind:search
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={() => { appliedSearch = search; appliedSearchField = searchField; page = 1; }}
  />

  <DataTable
    {columns}
    rows={filtered}
    getKey={(r) => r.id}
    empty={loading ? "…" : i18n.t.adminSessions.empty}
    bind:sort
    bind:page
    perPage={DEFAULT_PAGE_SIZE}
    label={fmt(i18n.t.adminSessions.total, { count: filtered.length })}
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
      <Table.Cell class="text-muted-foreground">{r.expiresAt ? formatDateTime(r.expiresAt) : "—"}</Table.Cell>
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
