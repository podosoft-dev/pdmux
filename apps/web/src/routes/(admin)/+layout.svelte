<script lang="ts">
  import * as Sidebar from "#lib/components/ui/sidebar/index.js";
  import { Separator } from "#lib/components/ui/separator/index.js";
  import AdminSidebar from "#lib/components/admin-sidebar.svelte";
  import ImpersonationBanner from "#lib/components/impersonation-banner.svelte";
  import ThemeToggle from "#lib/components/theme-toggle.svelte";
  import LanguageSwitch from "#lib/components/language-switch.svelte";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import type { SessionUser } from "../../app.d.ts";

  let {
    children,
    data,
  }: {
    children: import("svelte").Snippet;
    data: { user: SessionUser; impersonating: boolean; capabilities: { auditLog?: boolean } };
  } = $props();
</script>

<Sidebar.Provider>
  <AdminSidebar user={data.user} capabilities={data.capabilities} />
  <Sidebar.Inset>
    {#if data.impersonating}
      <ImpersonationBanner email={data.user.email} />
    {/if}
    <header class="flex h-14 items-center gap-2 border-b px-4">
      <Sidebar.Trigger />
      <Separator orientation="vertical" class="mr-2 h-4" />
      <div class="flex-1"></div>
      <LanguageSwitch />
      <ThemeToggle />
    </header>
    <main class="flex-1 overflow-auto p-6">
      {@render children()}
    </main>
  </Sidebar.Inset>
</Sidebar.Provider>
<Toaster />
