<script lang="ts">
  // Admin Appearance settings. Pending values stay inside the preview until
  // the user saves, then apply across the app through the shared theme helper.
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Moon from "@lucide/svelte/icons/moon";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Sun from "@lucide/svelte/icons/sun";
  import X from "@lucide/svelte/icons/x";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";
  import { site, type SiteSettings } from "$lib/site.svelte";
  import {
    FEATURED_THEME_PRESET_KEYS,
    THEME_TOKEN_KEYS,
    findPreset,
    themePresets,
    type ThemePreset,
    type ThemeTokens,
  } from "$lib/site/themes";
  import {
    applyTheme,
    buildVarString,
    effectiveTokens,
    parseOverrides,
    type ThemeConfig,
    type ThemeMode,
    type ThemeOverrides,
  } from "$lib/site/apply-theme";

  const i18n = getI18n();
  const t = $derived(i18n.t.general);
  const featuredKeys: readonly string[] = FEATURED_THEME_PRESET_KEYS;
  const featuredPresets = featuredKeys
    .map((key) => findPreset(key))
    .filter((item): item is ThemePreset => item !== undefined);
  const additionalPresets = themePresets.filter((item) => !featuredKeys.includes(item.key));

  const s = $derived(site.value);
  let preset = $state("default");
  let brandColor = $state("");
  let radius = $state("");
  let overrides = $state<ThemeOverrides>({ light: {}, dark: {} });
  let moreThemesOpen = $state(false);
  let advancedOpen = $state(false);
  let previewMode = $state<ThemeMode>("light");
  let advancedMode = $state<ThemeMode>("light");
  let seeded = $state(false);

  $effect(() => {
    if (seeded) return;
    preset = s.themePreset || "default";
    brandColor = s.brandColor ?? "";
    radius = s.themeRadius ?? "";
    const parsed = parseOverrides(s.themeOverrides);
    overrides = { light: { ...(parsed?.light ?? {}) }, dark: { ...(parsed?.dark ?? {}) } };
    seeded = true;
  });

  const config = $derived<ThemeConfig>({
    preset,
    brandColor: brandColor || null,
    radius: radius || null,
    overrides,
  });
  const lightVars = $derived(buildVarString(effectiveTokens(config, "light"), config.brandColor, config.radius));
  const darkVars = $derived(buildVarString(effectiveTokens(config, "dark"), config.brandColor, config.radius));

  function tokenValue(mode: ThemeMode, key: keyof ThemeTokens): string {
    return overrides[mode]?.[key] ?? findPreset(preset)?.[mode]?.[key] ?? "#808080";
  }

  function setToken(mode: ThemeMode, key: keyof ThemeTokens, value: string): void {
    overrides = { ...overrides, [mode]: { ...(overrides[mode] ?? {}), [key]: value } };
  }

  function selectPreset(key: string): void {
    preset = key;
    overrides = { light: {}, dark: {} };
  }

  function radiusLabel(value: string): string {
    if (value === "") return t.radiusDefault;
    if (value === "0") return t.radiusNone;
    if (value === "0.25") return t.radiusSmall;
    if (value === "0.5") return t.radiusMedium;
    return t.radiusLarge;
  }

  function cleanOverrides(): ThemeOverrides {
    const pick = (value?: Partial<ThemeTokens>): Partial<ThemeTokens> | undefined => {
      if (!value) return undefined;
      const entries = Object.entries(value).filter(([, token]) => Boolean(token));
      return entries.length ? (Object.fromEntries(entries) as Partial<ThemeTokens>) : undefined;
    };
    const result: ThemeOverrides = {};
    const light = pick(overrides.light);
    const dark = pick(overrides.dark);
    if (light) result.light = light;
    if (dark) result.dark = dark;
    return result;
  }

  let saving = $state(false);
  async function save(): Promise<void> {
    saving = true;
    try {
      const cleaned = cleanOverrides();
      const payload: Record<string, string> = {
        themePreset: preset === "default" ? "" : preset,
        brandColor,
        themeRadius: radius,
        themeOverrides: cleaned.light || cleaned.dark ? JSON.stringify(cleaned) : "",
      };
      await api.put("/site/settings", payload);
      site.patch(payload as Partial<SiteSettings>);
      applyTheme(config);
      toast.success(t.saved);
    } catch {
      toast.error(t.saveError);
    } finally {
      saving = false;
    }
  }

  async function restoreDefaults(): Promise<void> {
    preset = "default";
    brandColor = "";
    radius = "";
    overrides = { light: {}, dark: {} };
    await save();
  }
</script>

<Card.Root>
  <Card.Header class="gap-1.5 border-b border-border">
    <Card.Title role="heading" aria-level={2}>{t.appearanceTitle}</Card.Title>
    <Card.Description>{t.appearanceDesc}</Card.Description>
  </Card.Header>

  <Card.Content class="flex flex-col gap-8 pt-6">
    <section class="flex flex-col gap-3" aria-labelledby="featured-themes-heading">
      <div>
        <h3 id="featured-themes-heading" class="text-sm font-medium">{t.featuredThemes}</h3>
        <p class="text-muted-foreground mt-0.5 text-xs">{t.themePreset}</p>
      </div>
      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {#each featuredPresets as item (item.key)}
          {@render presetButton(item)}
        {/each}
      </div>

      <Collapsible.Root bind:open={moreThemesOpen}>
        <Collapsible.Trigger
          class="border-input bg-background hover:bg-accent hover:text-accent-foreground flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors"
        >
          {moreThemesOpen ? t.hideThemes : t.moreThemes}
          <ChevronDown class="size-4 transition-transform {moreThemesOpen ? 'rotate-180' : ''}" />
        </Collapsible.Trigger>
        <Collapsible.Content class="pt-3">
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {#each additionalPresets as item (item.key)}
              {@render presetButton(item)}
            {/each}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

    <div class="grid gap-8 xl:grid-cols-[minmax(0,0.8fr)_minmax(22rem,1.2fr)]">
      <section class="flex flex-col gap-5" aria-labelledby="quick-settings-heading">
        <h3 id="quick-settings-heading" class="text-sm font-medium">{t.quickSettings}</h3>

        <div class="flex flex-col gap-2">
          <Label for="accent-color">{t.accentColor}</Label>
          <div class="flex items-center gap-2">
            <Input
              type="color"
              value={brandColor || "#6d28d9"}
              oninput={(event) => (brandColor = event.currentTarget.value)}
              aria-label={t.accentColor}
              class="size-10 shrink-0 cursor-pointer p-1"
            />
            <Input id="accent-color" bind:value={brandColor} placeholder="#6d28d9" class="max-w-36 font-mono" />
            {#if brandColor}
              <Button type="button" variant="ghost" size="icon" onclick={() => (brandColor = "")} aria-label={t.clearColor}>
                <X class="size-4" />
              </Button>
            {/if}
          </div>
          <p class="text-muted-foreground text-xs leading-relaxed">{t.accentColorHint}</p>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-sm font-medium">{t.radius}</legend>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {#each ["", "0", "0.25", "0.5", "1"] as value (value)}
              <Button
                type="button"
                variant={radius === value ? "secondary" : "outline"}
                class="justify-center"
                aria-pressed={radius === value}
                onclick={() => (radius = value)}
              >
                {radiusLabel(value)}
              </Button>
            {/each}
          </div>
          {#if radius && !["0", "0.25", "0.5", "1"].includes(radius)}
            <p class="text-muted-foreground text-xs">{radius}rem</p>
          {/if}
        </fieldset>
      </section>

      <section class="flex flex-col gap-3" aria-labelledby="theme-preview-heading">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 id="theme-preview-heading" class="text-sm font-medium">{t.preview}</h3>
          <div class="bg-muted flex rounded-lg p-1" role="group" aria-label={t.preview}>
            <Button
              type="button"
              variant={previewMode === "light" ? "secondary" : "ghost"}
              size="sm"
              class="h-8 gap-1.5"
              aria-pressed={previewMode === "light"}
              onclick={() => (previewMode = "light")}
            >
              <Sun class="size-3.5" />{t.previewLight}
            </Button>
            <Button
              type="button"
              variant={previewMode === "dark" ? "secondary" : "ghost"}
              size="sm"
              class="h-8 gap-1.5"
              aria-pressed={previewMode === "dark"}
              onclick={() => (previewMode = "dark")}
            >
              <Moon class="size-3.5" />{t.previewDark}
            </Button>
          </div>
        </div>
        {@render previewPanel(previewMode === "light" ? lightVars : darkVars, previewMode === "dark")}
      </section>
    </div>

    <Collapsible.Root bind:open={advancedOpen}>
      <Collapsible.Trigger
        class="border-border hover:bg-muted flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors"
      >
        <span>{advancedOpen ? t.advancedHide : t.advanced}</span>
        <ChevronDown class="size-4 transition-transform {advancedOpen ? 'rotate-180' : ''}" />
      </Collapsible.Trigger>
      <Collapsible.Content class="pt-4">
        <div class="bg-muted/40 flex flex-col gap-4 rounded-lg border border-border p-4">
          <div class="flex w-fit rounded-md border border-border bg-background p-1" role="group" aria-label={t.advanced}>
            {#each ["light", "dark"] as mode (mode)}
              <Button
                type="button"
                variant={advancedMode === mode ? "secondary" : "ghost"}
                size="sm"
                class="h-8"
                aria-pressed={advancedMode === mode}
                onclick={() => (advancedMode = mode as ThemeMode)}
              >
                {mode === "light" ? t.previewLight : t.previewDark}
              </Button>
            {/each}
          </div>

          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each THEME_TOKEN_KEYS as key (key)}
              <div class="flex flex-col gap-1.5">
                <Label for={`theme-${advancedMode}-${key}`}>{t.themeTokens[key]}</Label>
                <div class="flex items-center gap-2">
                  <Input
                    type="color"
                    value={tokenValue(advancedMode, key)}
                    oninput={(event) => setToken(advancedMode, key, event.currentTarget.value)}
                    aria-label={`${t.themeTokens[key]} ${advancedMode}`}
                    class="size-9 shrink-0 cursor-pointer p-1"
                  />
                  <Input
                    id={`theme-${advancedMode}-${key}`}
                    value={tokenValue(advancedMode, key)}
                    oninput={(event) => setToken(advancedMode, key, event.currentTarget.value)}
                    class="min-w-0 font-mono text-xs"
                  />
                </div>
              </div>
            {/each}
          </div>

          <Button type="button" variant="outline" size="sm" class="w-fit gap-2" onclick={() => (overrides = { light: {}, dark: {} })}>
            <RotateCcw class="size-3.5" />{t.resetTheme}
          </Button>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>

    <div class="flex flex-wrap items-center gap-2 border-t border-border pt-6">
      <Button onclick={save} disabled={saving}>{saving ? t.saving : t.saveTheme}</Button>
      <Button variant="outline" onclick={restoreDefaults} disabled={saving}>{t.restoreDefaults}</Button>
    </div>
  </Card.Content>
</Card.Root>

{#snippet presetButton(item: ThemePreset)}
  <Button
    type="button"
    variant="outline"
    class="h-auto min-h-16 justify-start gap-3 px-3 py-2.5 text-left {preset === item.key ? 'border-primary bg-primary/5 ring-1 ring-primary' : ''}"
    aria-pressed={preset === item.key}
    onclick={() => selectPreset(item.key)}
  >
    {@render presetSwatch(item)}
    <span class="min-w-0 flex-1 truncate">{item.label}</span>
    {#if preset === item.key}<Check class="text-primary size-4 shrink-0" />{/if}
  </Button>
{/snippet}

{#snippet presetSwatch(item: ThemePreset)}
  <span class="border-border flex size-9 shrink-0 overflow-hidden rounded-md border" aria-hidden="true">
    {#if item.light}
      <span class="h-full w-1/2" style={`background:${item.light.background}`}></span>
      <span class="h-full w-1/2" style={`background:${item.light.primary}`}></span>
    {:else}
      <span class="bg-background h-full w-1/2"></span>
      <span class="bg-primary h-full w-1/2"></span>
    {/if}
  </span>
{/snippet}

{#snippet previewPanel(vars: string, dark: boolean)}
  <div class="border-border overflow-hidden rounded-xl border">
    <div class="bg-background text-foreground grid min-h-72 grid-cols-[5.5rem_1fr] sm:grid-cols-[9rem_1fr] {dark ? 'dark' : ''}" style={vars}>
      <aside class="bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col gap-4 border-r p-3">
        <div class="flex items-center gap-2 text-xs font-semibold">
          <span class="bg-primary size-5 rounded-md"></span>
          <span class="hidden truncate sm:inline">{t.previewApp}</span>
        </div>
        <div class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground rounded-md px-2 py-1.5">{t.previewNav}</span>
          <span class="bg-sidebar-accent text-sidebar-accent-foreground rounded-md px-2 py-1.5">{t.previewSettings}</span>
        </div>
      </aside>
      <div class="flex flex-col gap-4 p-4 sm:p-6">
        <div class="space-y-1">
          <p class="text-base font-semibold">{t.previewHeading}</p>
          <p class="text-muted-foreground max-w-md text-xs leading-relaxed">{t.previewBody}</p>
        </div>
        <div class="bg-card text-card-foreground border-border flex flex-col gap-4 rounded-lg border p-4">
          <div class="space-y-2">
            <div class="bg-muted h-2.5 w-2/3 rounded-full"></div>
            <div class="bg-muted h-2.5 w-1/2 rounded-full"></div>
          </div>
          <div class="border-input bg-background h-9 rounded-md border"></div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="bg-primary text-primary-foreground rounded-md px-3 py-2 text-xs font-medium">{t.previewPrimary}</span>
            <span class="border-border rounded-md border px-3 py-2 text-xs">{t.previewOutline}</span>
            <span class="bg-secondary text-secondary-foreground rounded-full px-2 py-1 text-[11px]">{t.previewBadge}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
{/snippet}
