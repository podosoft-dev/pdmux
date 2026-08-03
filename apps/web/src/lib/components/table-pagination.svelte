<script lang="ts">
  import * as Pagination from "$lib/components/ui/pagination";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import { getI18n } from "$lib/i18n";

  // Shared table footer: a count label plus shadcn-svelte pagination. The pager
  // is always shown (even for a single page or an empty list) so the footer stays
  // consistent across tables. Bind `page` (1-based). For server-side lists pass
  // `onPageChange` to refetch; client-side lists just bind.
  type Props = {
    count: number;
    perPage?: number;
    page?: number;
    label?: string;
    onPageChange?: (page: number) => void;
  };
  let { count, perPage = 5, page = $bindable(1), label, onPageChange }: Props = $props();
  const i18n = getI18n();
</script>

<div class="flex items-center justify-between gap-2">
  {#if label}
    <span class="text-muted-foreground shrink-0 text-sm whitespace-nowrap">{label}</span>
  {/if}
  <Pagination.Root count={Math.max(count, 1)} {perPage} bind:page {onPageChange}>
    {#snippet children({ pages, currentPage })}
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.PrevButton>
            <ChevronLeftIcon class="size-4" />
            <span>{i18n.t.dash.table.prevPage}</span>
          </Pagination.PrevButton>
        </Pagination.Item>
        {#each pages as p (p.key)}
          {#if p.type === "ellipsis"}
            <Pagination.Item><Pagination.Ellipsis /></Pagination.Item>
          {:else}
            <Pagination.Item>
              <Pagination.Link page={p} isActive={currentPage === p.value}>{p.value}</Pagination.Link>
            </Pagination.Item>
          {/if}
        {/each}
        <Pagination.Item>
          <Pagination.NextButton>
            <span>{i18n.t.dash.table.nextPage}</span>
            <ChevronRightIcon class="size-4" />
          </Pagination.NextButton>
        </Pagination.Item>
      </Pagination.Content>
    {/snippet}
  </Pagination.Root>
</div>
