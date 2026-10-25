<script lang="ts">
  /**
   * The error page for anything below the root layout, in the reader's language.
   *
   * Without it SvelteKit rendered its own English page — "503 Service temporarily unavailable" —
   * on a Korean screen. When the root layout itself fails, SvelteKit serves `src/error.html`
   * instead; this page only runs once that layout's data (and with it the catalogue) is loaded.
   */
  import { page } from "$app/state";
  import { Button } from "#lib/components/ui/button/index.js";
  import { errorPageText } from "#lib/error-page.js";
  import type { Messages } from "#lib/i18n/messages.js";

  const text = $derived(errorPageText(page.status, (page.data as { messages?: Messages }).messages));
</script>

<svelte:head><title>{text.status} · PDMux</title></svelte:head>

<main class="bg-background text-foreground grid min-h-dvh place-items-center p-6" data-testid="error-page">
  <div class="flex max-w-md flex-col items-center gap-3 text-center">
    <p class="text-muted-foreground text-sm" data-testid="error-status">{text.status}</p>
    <h1 class="text-xl font-semibold">{text.title}</h1>
    <p class="text-muted-foreground text-sm" data-testid="error-message">{text.message}</p>
    <div class="mt-2 flex gap-2">
      <Button variant="outline" onclick={() => location.reload()}>{text.retry}</Button>
      <Button href="/">{text.home}</Button>
    </div>
  </div>
</main>
