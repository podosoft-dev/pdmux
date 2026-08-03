---
name: podokit-data-table
description: Use when building ANY list or table view in this project (users, sessions, orders, any collection) — including inside dialogs. PodoKit requires the shared DataTable component; never assemble a table by hand.
---

# Build a list with the shared DataTable

**Every** list/table in this project must use `$lib/components/data-table.svelte`
(`DataTable`) — it provides sortable headers and a footer pagination, consistently.
Do **not** assemble `Table.Root` / `Table.Header` / `Table.Body` by hand, and don't
put pagination outside the table.

```svelte
<script lang="ts">
  import DataTable from "$lib/components/data-table.svelte";
  const columns = [
    { key: "name", label: "Name", sortable: true },
    { key: "email", label: "Email", sortable: true },
    { key: "role", label: "Role", sortable: true },     // action/status columns: no `sortable`
  ];
  let { rows } = $props();   // Svelte 5 runes only
</script>

<DataTable {columns} {rows} label="{rows.length} users">
  {#snippet row(item)}
    <Table.Cell>{item.name}</Table.Cell>
    <Table.Cell>{item.email}</Table.Cell>
    <Table.Cell>{item.role}</Table.Cell>
  {/snippet}
</DataTable>
```

- **Client data** (bounded): pass `rows`; DataTable sorts/paginates internally.
- **Server data** (huge lists): use `manualSort` + `manualPagination` + `total`
  + `onChange` (re-fetch with `sortBy`/`sortDirection`/`page`).
- Nested/derived sort keys: give the column a `value` accessor.
- No footer needed: `perPage={0}`.
- **Search & filters**: put the shared `table-toolbar.svelte` (`TableToolbar`)
  above the DataTable. Filters + search apply together on the Search button/Enter
  (don't query on every keystroke); the search field is a `select` of columns.

The `/admin/users` page is the reference implementation. See `docs/development.md`
("Data tables", "Search & filters") on the PodoKit repo.
