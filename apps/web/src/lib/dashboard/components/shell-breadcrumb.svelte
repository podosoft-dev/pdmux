<script lang="ts" module>
  export type Crumb = {
    label: string;
    /** Omitted for the current page, which is rendered as text, not a link. */
    href?: string;
    testId?: string;
  };
</script>

<script lang="ts">
  /**
   * Where you are inside the shell, and one click back out of it.
   *
   * It replaced a pair of buttons ("Dashboard", "Back to the dashboard") that made
   * sense while host management had a header of its own. With the sidebar permanently
   * on the left, a button that size claims to leave the app; a breadcrumb says the
   * truth — this screen is one level inside the same shell.
   */
  let { crumbs, label }: { crumbs: readonly Crumb[]; label: string } = $props();
</script>

<nav class="text-muted-foreground flex items-center gap-1.5 text-xs" aria-label={label} data-testid="shell-breadcrumb">
  {#each crumbs as crumb, index (crumb.label)}
    {#if index > 0}<span aria-hidden="true">/</span>{/if}
    {#if crumb.href}
      <a href={crumb.href} data-testid={crumb.testId} class="hover:text-foreground underline-offset-2 hover:underline"
        >{crumb.label}</a
      >
    {:else}
      <span class="text-foreground font-medium" aria-current="page" data-testid={crumb.testId}>{crumb.label}</span>
    {/if}
  {/each}
</nav>
