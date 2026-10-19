<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { setMode, userPrefersMode } from "mode-watcher";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { LOCALES, localeNames } from "#lib/i18n/messages.js";
  import { useSettings } from "./settings-state.svelte.js";

  const i18n = getI18n();
  const settings = useSettings();
  let locale = $state(i18n.locale);
  let mode = $state(userPrefersMode.current ?? "system");
  let savedLocale = $state(untrack(() => locale));
  let savedMode = $state(untrack(() => mode));
  onMount(() => settings?.register("general", {
    get dirty() { return locale !== savedLocale || mode !== savedMode; },
    get valid() { return LOCALES.includes(locale) && ["light", "dark", "system"].includes(mode); },
    busy: false,
    reset() { locale = savedLocale; mode = savedMode; },
    async save() {
      const languageChanged = locale !== savedLocale;
      if (languageChanged) {
        document.cookie = `locale=${locale};path=/;max-age=31536000;samesite=lax`;
        document.documentElement.lang = locale;
      }
      setMode(mode);
      if (languageChanged) await invalidateAll();
      savedLocale = locale; savedMode = mode;
      return true;
    },
  }));
</script>

<div class="grid gap-4 p-4 sm:p-6" data-testid="desktop-general-settings">
  <Card.Root><Card.Header><Card.Title>{i18n.t.desktop.preferences.general}</Card.Title></Card.Header><Card.Content class="grid gap-5">
    <div class="grid gap-2"><Label for="settings-language">{i18n.t.language.label}</Label><Select.Root type="single" bind:value={locale}><Select.Trigger id="settings-language" class="w-full" data-testid="settings-language">{localeNames[locale]}</Select.Trigger><Select.Content>{#each LOCALES as language}<Select.Item value={language}>{localeNames[language]}</Select.Item>{/each}</Select.Content></Select.Root></div>
    <div class="grid gap-2"><Label for="settings-theme">{i18n.t.desktop.preferences.appTheme}</Label><Select.Root type="single" bind:value={mode}><Select.Trigger id="settings-theme" class="w-full" data-testid="settings-theme">{i18n.t.theme[mode]}</Select.Trigger><Select.Content>{#each ["light", "dark", "system"] as theme}<Select.Item value={theme}>{i18n.t.theme[theme as "light" | "dark" | "system"]}</Select.Item>{/each}</Select.Content></Select.Root></div>
  </Card.Content></Card.Root>
</div>
