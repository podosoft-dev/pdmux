<script lang="ts" module>
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";

  export type DataTableBreakpoint = "sm" | "md" | "lg" | "xl";
  export type DataTableColumn<Row> = {
    key: string;
    label: string;
    /** Optional interactive header content, such as a select-all checkbox. */
    head?: Snippet;
    sortable?: boolean;
    class?: string;
    hideBelow?: DataTableBreakpoint;
    // Value used for client-side sorting (defaults to row[key]). Use for nested
    // or derived fields, e.g. (s) => s.user.email.
    value?: (row: Row) => string | number | boolean | Date | null | undefined;
  };
  export type SortState = { key: string; dir: "asc" | "desc" };
  export type DataTableRowContext = {
    cellClass: (columnKey: string) => string | undefined;
  };

  const HIDE_BELOW_CLASS: Record<DataTableBreakpoint, string> = {
    sm: "max-sm:hidden",
    md: "max-md:hidden",
    lg: "max-lg:hidden",
    xl: "max-xl:hidden",
  };

  export function getDataTableColumnClass<Row>(
    column: DataTableColumn<Row>,
  ): string | undefined {
    return cn(column.class, column.hideBelow ? HIDE_BELOW_CLASS[column.hideBelow] : undefined);
  }

  // Shared page size for all admin tables — sized so a desktop viewport shows a
  // full list at a glance (rather than the old 5-row pages). Change it here to
  // retune every table at once.
  export const DEFAULT_PAGE_SIZE = 15;
</script>

<script lang="ts" generics="Row">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import TablePagination from "#lib/components/table-pagination.svelte";
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";

  // The one table used across the admin console: sortable headers + a shared
  // pagination footer. Two modes:
  //  - client (default): pass all `rows`; sorting + paging happen here.
  //  - manual (server): set manualSort/manualPagination, pass `total`, and refetch
  //    in `onChange` using the emitted sort + page.
  type Props = {
    columns: DataTableColumn<Row>[];
    rows: Row[];
    row: Snippet<[Row, DataTableRowContext]>; // renders the <Table.Cell>s for one row
    getKey?: (row: Row, index: number) => string | number;
    empty?: string;
    ariaLabel?: string;
    sort?: SortState | null;
    manualSort?: boolean;
    page?: number;
    perPage?: number; // 0 => no pagination footer
    total?: number; // server total (defaults to rows.length)
    label?: string;
    manualPagination?: boolean;
    onChange?: (state: { sort: SortState | null; page: number }) => void;
  };
  let {
    columns,
    rows,
    row,
    getKey = (_r, i) => i,
    empty = "No data.",
    ariaLabel,
    sort = $bindable(null),
    manualSort = false,
    page = $bindable(1),
    perPage = 0,
    total,
    label,
    manualPagination = false,
    onChange,
  }: Props = $props();

  function toggle(col: DataTableColumn<Row>): void {
    if (!col.sortable) return;
    sort =
      sort?.key === col.key
        ? { key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: "asc" };
    if (!manualPagination) page = 1;
    onChange?.({ sort, page });
  }

  function cellClass(columnKey: string): string | undefined {
    const column = columns.find((candidate) => candidate.key === columnKey);
    return column ? getDataTableColumnClass(column) : undefined;
  }

  const rowContext: DataTableRowContext = { cellClass };

  function cmp(a: unknown, b: unknown): number {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  const sorted = $derived.by(() => {
    if (manualSort || !sort) return rows;
    const active = sort;
    const col = columns.find((c) => c.key === active.key);
    const read = (r: Row) => (col?.value ? col.value(r) : (r as Record<string, unknown>)[active.key]);
    const factor = active.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => cmp(read(a), read(b)) * factor);
  });
  const view = $derived.by(() =>
    perPage && !manualPagination ? sorted.slice((page - 1) * perPage, page * perPage) : sorted,
  );
  const count = $derived(total ?? rows.length);
</script>

<div class="rounded-md border">
  <Table.Root aria-label={ariaLabel}>
    <Table.Header>
      <Table.Row>
        {#each columns as col (col.key)}
          <Table.Head
            class={getDataTableColumnClass(col)}
            aria-sort={sort?.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
          >
            {#if col.head}
              {@render col.head()}
            {:else if col.sortable}
              <Button variant="ghost" size="sm" class="-mx-2 h-auto gap-1 px-2 py-1 font-medium" onclick={() => toggle(col)}>
                {col.label}
                {#if sort?.key === col.key}
                  {#if sort.dir === "asc"}<ChevronUpIcon class="size-3.5" />{:else}<ChevronDownIcon class="size-3.5" />{/if}
                {:else}
                  <ChevronsUpDownIcon class="size-3.5 opacity-40" />
                {/if}
              </Button>
            {:else}
              {col.label}
            {/if}
          </Table.Head>
        {/each}
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each view as r, i (getKey(r, i))}
        <Table.Row>{@render row(r, rowContext)}</Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell colspan={columns.length} class="text-muted-foreground py-8 text-center">{empty}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
    <!-- Pagination lives in the table footer so every DataTable is consistent
         top-to-bottom (sortable header, rows, footer pager). -->
    {#if perPage}
      <Table.Footer class="bg-transparent">
        <Table.Row class="hover:bg-transparent">
          <Table.Cell colspan={columns.length} class="py-2">
            <TablePagination
              {count}
              {perPage}
              bind:page
              {label}
              onPageChange={manualPagination ? (p) => onChange?.({ sort, page: p }) : undefined}
            />
          </Table.Cell>
        </Table.Row>
      </Table.Footer>
    {/if}
  </Table.Root>
</div>
