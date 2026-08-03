<script lang="ts" module>
  export type ToolbarFilter = {
    key: string;
    label: string;
    // First option is the "all" choice (usually value "").
    options: { value: string; label: string }[];
  };
  export type ToolbarSearchField = { value: string; label: string };
</script>

<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";

  // Shared toolbar above a DataTable. Filters (enum columns) and search (free-text
  // columns that can't be a filter) both commit together on the Search button /
  // Enter — never per keystroke, so many conditions apply in one pass. The search
  // field itself is a select, so a page can search by Email, Name, ... whatever
  // isn't covered by a filter.
  type Props = {
    filters?: ToolbarFilter[];
    filterValues?: Record<string, string>;
    searchFields?: ToolbarSearchField[]; // ≥1 to show the search row
    searchField?: string; // selected field value (bound)
    searchPlaceholder?: string;
    search?: string; // the query text (bound)
    filterHeading?: string;
    searchHeading?: string;
    searchButton?: string;
    onSearch: () => void; // commit filters + search + field together
  };
  let {
    filters = [],
    filterValues = $bindable({}),
    searchFields = [],
    searchField = $bindable(""),
    searchPlaceholder,
    search = $bindable(""),
    filterHeading = "Filter",
    searchHeading = "Search",
    searchButton = "Search",
    onSearch,
  }: Props = $props();

  function filterTrigger(f: ToolbarFilter): string {
    return f.options.find((o) => o.value === (filterValues[f.key] ?? ""))?.label ?? f.options[0]?.label ?? "";
  }
  const searchFieldLabel = $derived(
    searchFields.find((f) => f.value === searchField)?.label ?? searchFields[0]?.label ?? "",
  );
</script>

<div class="flex flex-col gap-3 rounded-md border p-3">
  {#if filters.length}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span class="text-muted-foreground w-14 shrink-0 text-sm font-medium">{filterHeading}</span>
      {#each filters as f (f.key)}
        <div class="flex items-center gap-2">
          <Label class="text-sm">{f.label}</Label>
          <Select.Root type="single" bind:value={filterValues[f.key]}>
            <Select.Trigger class="w-36">{filterTrigger(f)}</Select.Trigger>
            <Select.Content>
              {#each f.options as o (o.value)}
                <Select.Item value={o.value}>{o.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/each}
    </div>
  {/if}
  {#if searchFields.length}
    <form class="flex flex-wrap items-center gap-2" onsubmit={(e) => { e.preventDefault(); onSearch(); }}>
      <span class="text-muted-foreground w-14 shrink-0 text-sm font-medium">{searchHeading}</span>
      {#if searchFields.length > 1}
        <Select.Root type="single" bind:value={searchField}>
          <Select.Trigger class="w-32">{searchFieldLabel}</Select.Trigger>
          <Select.Content>
            {#each searchFields as f (f.value)}
              <Select.Item value={f.value}>{f.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {:else}
        <Label class="text-sm" for="toolbar-search">{searchFields[0].label}</Label>
      {/if}
      <Input id="toolbar-search" bind:value={search} placeholder={searchPlaceholder} class="max-w-xs flex-1" />
      <Button type="submit">{searchButton}</Button>
    </form>
  {/if}
</div>
