<script lang="ts">
  import { page } from "$app/state";
  import { ModeWatcher } from "mode-watcher";
  import { site, type SiteSettings } from "$lib/site.svelte";
  import { applyTheme, themeConfigFromSettings } from "$lib/site/apply-theme";
  import SessionIdleTimeout from "$lib/components/session-idle-timeout.svelte";
  // Optional modules add global runtime components here without taking
  // ownership of the application's root layout.
  // podokit:begin:site-runtime-imports
  // podokit:end:site-runtime-imports

  const loadedSite = $derived(
    (page.data as { site?: Partial<SiteSettings> | null }).site,
  );
  const sessionIdleTimeoutMinutes = $derived(
    (page.data as { sessionIdleTimeoutMinutes?: number | null }).sessionIdleTimeoutMinutes ?? null,
  );

  // Seed the reactive site settings for every route without taking ownership of
  // the application's root layout or public pages.
  $effect.pre(() => site.init(loadedSite));

  const branding = $derived({
    name: site.value.name ?? loadedSite?.name ?? "",
    description: site.value.description ?? loadedSite?.description ?? "",
    hasFavicon: site.value.hasFavicon || Boolean(loadedSite?.hasFavicon),
    faviconVersion: site.value.faviconVersion ?? loadedSite?.faviconVersion ?? "",
  });

  $effect(() => {
    applyTheme(themeConfigFromSettings(site.value));
  });
</script>

<svelte:head>
  {#if branding.name}
    <title>{branding.name}</title>
  {/if}
  {#if branding.description}
    <meta name="description" content={branding.description} />
  {/if}
  {#if branding.hasFavicon}
    <link rel="icon" href={`/api/site/favicon?v=${branding.faviconVersion}`} />
  {/if}
</svelte:head>

<ModeWatcher />
<SessionIdleTimeout timeoutMinutes={sessionIdleTimeoutMinutes} />
<!-- podokit:begin:site-runtime-components -->
<!-- podokit:end:site-runtime-components -->
