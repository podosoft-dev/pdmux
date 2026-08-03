<script lang="ts">
  import { goto } from "$app/navigation";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { Separator } from "$lib/components/ui/separator";
  import { Button } from "$lib/components/ui/button";
  import AdminSidebar from "$lib/components/admin-sidebar.svelte";
  import ThemeToggle from "$lib/components/theme-toggle.svelte";
  import LanguageSwitch from "$lib/components/language-switch.svelte";
  import { Toaster } from "$lib/components/ui/sonner";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";
  import type { SessionUser } from "../../app.d.ts";

  let {
    children,
    data,
  }: {
    children: import("svelte").Snippet;
    data: { user: SessionUser; impersonating: boolean; capabilities: { auditLog?: boolean } };
  } = $props();
  const i18n = getI18n();

  async function stopImpersonating(): Promise<void> {
    await api.auth.admin.stopImpersonating();
    await goto("/admin", { invalidateAll: true });
  }
</script>

<Sidebar.Provider>
  <AdminSidebar user={data.user} capabilities={data.capabilities} />
  <Sidebar.Inset>
    {#if data.impersonating}
      <div class="bg-primary text-primary-foreground flex items-center justify-between gap-2 px-4 py-2 text-sm">
        <span>{i18n.t.users.impersonatingAs.replace("{email}", data.user.email)}</span>
        <Button variant="secondary" size="sm" onclick={stopImpersonating}>{i18n.t.users.stopImpersonating}</Button>
      </div>
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
