<script lang="ts">
  /**
   * The signed-in person's own account, inside the product shell.
   *
   * It used to be a standalone page with its own header (home button, language, theme)
   * and footer, so opening it from the sidebar menu made the fleet disappear — the same
   * complaint that moved host management into this group. Account is a product screen
   * for a signed-in user, so it renders in the right-hand area with the cards still on
   * the left, and the chrome the shell already provides is gone from here rather than
   * duplicated.
   *
   * The screen itself is PodoKit's `account-page.svelte` (managed): it is reused whole,
   * never edited or forked, so every auth feature it grows arrives here for free.
   */
  import AccountPage from "$lib/components/account-page.svelte";
  import ShellBreadcrumb from "$lib/dashboard/components/shell-breadcrumb.svelte";
  import { getI18n } from "$lib/i18n";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();

  const crumbs = $derived([
    { label: i18n.t.dash.title, href: "/", testId: "open-dashboard" },
    { label: i18n.t.nav.account },
  ]);

  /**
   * The shell redirects anonymous visitors, so a session is guaranteed here — but the
   * managed loader's `user` is typed nullable (it is shared with the admin console's own
   * account route), so this narrows instead of asserting.
   */
  const account = $derived(data.user ? { ...data, user: data.user } : null);
</script>

<svelte:head><title>{i18n.t.nav.account} · pdmux</title></svelte:head>

<!-- The shell owns the viewport, so this column owns its own scrolling (ARCHITECTURE §7). -->
<div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-6" data-testid="account-panel" data-pdmux-region="page">
  <ShellBreadcrumb {crumbs} label={i18n.t.dash.breadcrumbLabel} />
  <!-- The forms read better at a measure than stretched across a wide column. -->
  <div class="w-full max-w-5xl">
    {#if account}<AccountPage data={account} />{/if}
  </div>
</div>
