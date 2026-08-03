<script lang="ts">
  import LanguageSwitch from "$lib/components/language-switch.svelte";
  import SiteFooter from "$lib/components/site-footer.svelte";
  let { children } = $props();
</script>

<div class="bg-muted/30 relative flex min-h-svh flex-col p-6">
  <div class="absolute right-4 top-4">
    <LanguageSwitch />
  </div>
  <div class="flex flex-1 items-center justify-center">
    <div class="w-full max-w-sm">
      {@render children()}
    </div>
  </div>
  <SiteFooter />
</div>
