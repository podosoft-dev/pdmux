<script lang="ts">
  import { ModeWatcher } from "mode-watcher";
  import { site } from "#lib/site.svelte.js";
  $effect.pre(() => site.init({ name: "PDMux" }));
</script>

<svelte:head><title>PDMux</title></svelte:head>

<ModeWatcher lightClassNames={["light"]} />
