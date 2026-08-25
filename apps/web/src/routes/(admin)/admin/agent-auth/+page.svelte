<script lang="ts">
  /**
   * Which agents the gateway is turning away.
   *
   * THE POINT OF THE SCREEN: an agent that has lost its credential — its host
   * deleted, its token revoked or lapsed — reconnects forever and, until this
   * existed, left no trace anywhere. The refusal ladder answered 401/403 and logged
   * nothing; the only symptom was a machine that never appeared. Salt's
   * `salt-key -L` is the precedent: the master lists what it is refusing, because
   * "why is this box not showing up" is a question the server can answer and the
   * box cannot.
   *
   * ⚠ IT IS AN AGGREGATE, NOT A LOG. One row per (reason, host, source address)
   * with a count — a per-attempt list of a retrying agent grows without limit while
   * saying the same sentence over and over.
   */
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarFilter, type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import { toast } from "svelte-sonner";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";

  const i18n = getI18n();

  type Refusal = {
    id: string;
    reason: string;
    hostId: string | null;
    hostLabel: string | null;
    sourceIp: string;
    count: number;
    firstSeenAt: string;
    lastSeenAt: string;
  };

  let rows = $state<Refusal[]>([]);
  let page = $state(1);
  let sort = $state<SortState | null>({ key: "lastSeenAt", dir: "desc" });
  let search = $state("");
  let appliedSearch = $state("");
  let filterValues = $state<Record<string, string>>({ reason: "" });
  let appliedFilters = $state<Record<string, string>>({ reason: "" });
  let searchField = $state("host");
  let appliedSearchField = $state("host");

  /**
   * The refusal vocabulary, spelled out.
   *
   * The stored value is the protocol's own name (`missing_key`, `host_deleted`, …)
   * because that is what the server, the aggregate and the agent all speak. What an
   * administrator needs on screen is the consequence, not the token.
   */
  function reasonLabel(reason: string): string {
    const copy = i18n.t.agentAuth;
    if (reason === "missing_key") return copy.reasonMissingKey;
    if (reason === "unknown") return copy.reasonUnknown;
    if (reason === "revoked") return copy.reasonRevoked;
    if (reason === "expired") return copy.reasonExpired;
    if (reason === "host_disabled") return copy.reasonHostDisabled;
    if (reason === "host_deleted") return copy.reasonHostDeleted;
    return reason;
  }

  const columns = $derived<DataTableColumn<Refusal>[]>([
    { key: "lastSeenAt", label: i18n.t.agentAuth.lastSeen, sortable: true, class: "whitespace-nowrap" },
    { key: "reason", label: i18n.t.agentAuth.reason, sortable: true, value: (row) => reasonLabel(row.reason) },
    { key: "host", label: i18n.t.agentAuth.host, sortable: true, value: (row) => row.hostLabel ?? row.hostId },
    { key: "sourceIp", label: i18n.t.agentAuth.source, sortable: true },
    { key: "count", label: i18n.t.agentAuth.count, sortable: true, class: "text-right" },
    { key: "firstSeenAt", label: i18n.t.agentAuth.firstSeen, sortable: true, class: "whitespace-nowrap" },
  ]);

  const reasons = $derived([...new Set(rows.map((row) => row.reason))].sort());
  const filters = $derived<ToolbarFilter[]>([
    {
      key: "reason",
      label: i18n.t.agentAuth.reason,
      options: [
        { value: "", label: i18n.t.toolbar.all },
        ...reasons.map((reason) => ({ value: reason, label: reasonLabel(reason) })),
      ],
    },
  ]);

  const searchFields = $derived<ToolbarSearchField[]>([
    { value: "host", label: i18n.t.agentAuth.host },
    { value: "source", label: i18n.t.agentAuth.source },
  ]);

  const filtered = $derived(
    rows.filter((row) => {
      if (appliedFilters.reason && row.reason !== appliedFilters.reason) return false;
      if (appliedSearch) {
        const hay = (
          appliedSearchField === "source" ? row.sourceIp : `${row.hostLabel ?? ""} ${row.hostId ?? ""}`
        ).toLowerCase();
        if (!hay.includes(appliedSearch.toLowerCase())) return false;
      }
      return true;
    }),
  );

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/agent-auth-failures");
      if (!res.ok) throw new Error();
      rows = (await res.json()) as Refusal[];
    } catch {
      toast.error(i18n.t.agentAuth.loadFailed);
    }
  }

  $effect(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-col gap-1">
    <h1 class="text-2xl font-semibold">{i18n.t.agentAuth.title}</h1>
    <p class="text-muted-foreground text-sm">{i18n.t.agentAuth.intro}</p>
  </div>

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
    getKey={(row) => row.id}
    empty={i18n.t.agentAuth.empty}
    bind:sort
    bind:page
    perPage={DEFAULT_PAGE_SIZE}
    label={fmt(i18n.t.agentAuth.total, { count: filtered.length })}
  >
    {#snippet row(entry)}
      <Table.Cell class="text-muted-foreground whitespace-nowrap">{formatDateTime(entry.lastSeenAt)}</Table.Cell>
      <Table.Cell><Badge variant="secondary">{reasonLabel(entry.reason)}</Badge></Table.Cell>
      <Table.Cell class="max-w-xs truncate">
        {#if entry.hostId}
          <!-- A deleted host has no page left to reach, so only a live one links. -->
          {#if entry.hostLabel}
            <a class="hover:underline" href={`/hosts/${entry.hostId}`}>{entry.hostLabel}</a>
          {:else}
            <span class="text-muted-foreground font-mono text-xs">{entry.hostId}</span>
          {/if}
        {:else}
          <span class="text-muted-foreground">{i18n.t.agentAuth.unknownHost}</span>
        {/if}
      </Table.Cell>
      <Table.Cell class="text-muted-foreground font-mono text-xs">{entry.sourceIp}</Table.Cell>
      <Table.Cell class="text-right tabular-nums">{entry.count}</Table.Cell>
      <Table.Cell class="text-muted-foreground whitespace-nowrap">{formatDateTime(entry.firstSeenAt)}</Table.Cell>
    {/snippet}
  </DataTable>
</div>
