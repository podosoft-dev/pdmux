<script lang="ts">
  import "../app.css";
  import SiteRuntime from "$lib/components/site-runtime.svelte";

  let { children } = $props();
</script>

<SiteRuntime />
{@render children()}
