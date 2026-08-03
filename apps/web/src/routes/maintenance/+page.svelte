<script lang="ts">
  // Shown to non-admin visitors while maintenance mode is on (see +layout.server.ts).
  // Admins are never redirected here and can sign in to turn it off.
  import { Button } from "$lib/components/ui/button";
  import LanguageSwitch from "$lib/components/language-switch.svelte";
  import ThemeToggle from "$lib/components/theme-toggle.svelte";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
</script>

<div class="flex min-h-svh flex-col">
  <header class="flex items-center justify-end gap-2 p-4">
    <LanguageSwitch />
    <ThemeToggle />
  </header>
  <main class="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
    <div class="flex flex-col gap-3">
      <h1 class="text-3xl font-semibold">{i18n.t.maintenance.title}</h1>
      <p class="text-muted-foreground max-w-md">{i18n.t.maintenance.subtitle}</p>
      <p class="text-muted-foreground text-sm">{i18n.t.maintenance.adminHint}</p>
    </div>
    <Button href="/login" variant="outline">{i18n.t.maintenance.signIn}</Button>
  </main>
</div>
