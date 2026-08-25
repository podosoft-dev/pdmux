<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import GlobeIcon from "@lucide/svelte/icons/globe";
  import { getI18n } from "#lib/i18n/index.js";
  import { LOCALES, localeNames, type Locale } from "#lib/i18n/messages.js";

  const i18n = getI18n();

  async function change(locale: Locale): Promise<void> {
    document.cookie = `locale=${locale};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.lang = locale;
    await invalidateAll();
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon" aria-label={i18n.t.language.label}>
        <GlobeIcon class="size-4" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    {#each LOCALES as locale (locale)}
      <DropdownMenu.Item onSelect={() => change(locale)} class={i18n.locale === locale ? "font-medium" : ""}>
        {localeNames[locale]}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
