<script lang="ts">
  import "../app.css";
  import SiteRuntime from "#lib/components/site-runtime.svelte";

  let { children } = $props();

  // Playwright waits for this client-only signal before interacting with SSR markup.
  // A rendered form is not enough: its Svelte event handlers may still be unattached.
  $effect(() => {
    document.documentElement.dataset.hydrated = "true";
    return () => {
      delete document.documentElement.dataset.hydrated;
    };
  });
</script>

<SiteRuntime />
{@render children()}
