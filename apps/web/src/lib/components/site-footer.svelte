<script lang="ts">
  // Public site footer: renders the admin-configured footer text and links
  // (support email, terms, privacy). Each element only shows when its value is
  // set in Settings, so an unconfigured site has no empty footer.
  import { site } from "$lib/site.svelte";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
  const s = $derived(site.value);
  const hasLinks = $derived(Boolean(s.supportEmail || s.termsUrl || s.privacyUrl));
</script>

{#if s.footerText || hasLinks}
  <footer class="text-muted-foreground flex flex-col items-center gap-1 px-4 py-6 text-center text-sm">
    {#if s.footerText}
      <p>{s.footerText}</p>
    {/if}
    {#if hasLinks}
      <nav class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {#if s.supportEmail}
          <a href={`mailto:${s.supportEmail}`} class="hover:text-foreground hover:underline">{i18n.t.footer.support}</a>
        {/if}
        {#if s.termsUrl}
          <a href={s.termsUrl} class="hover:text-foreground hover:underline">{i18n.t.footer.terms}</a>
        {/if}
        {#if s.privacyUrl}
          <a href={s.privacyUrl} class="hover:text-foreground hover:underline">{i18n.t.footer.privacy}</a>
        {/if}
      </nav>
    {/if}
  </footer>
{/if}
