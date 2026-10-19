<script lang="ts">
  import LanguageSwitch from "#lib/components/language-switch.svelte";
  import ThemeToggle from "#lib/components/theme-toggle.svelte";
  import { userPrefersMode } from "mode-watcher";
  import { localeNames } from "#lib/i18n/messages.js";
  import { page } from "$app/state";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import InfoHint from "#lib/dashboard/components/info-hint.svelte";
  import TerminalSettings from "#lib/desktop/terminal-settings.svelte";
  import { desktopActions } from "#lib/desktop.js";
  import { getI18n } from "#lib/i18n/index.js";
  const i18n = getI18n();
  let failed = $state(false);
  let pending = $state(false);
  async function openData(): Promise<void> {
    pending = true; failed = false;
    try { const actions = desktopActions(); if (!actions) throw new Error("Desktop actions unavailable"); await actions.run("open-data"); }
    catch { failed = true; }
    finally { pending = false; }
  }
</script>

<svelte:head><title>{i18n.t.desktop.preferences.title} · PDMux</title></svelte:head>
<div class="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-6" data-pdmux-region="page" data-testid="desktop-preferences-panel">
  {#if page.url.searchParams.get("tab") === "general"}
    <h2 class="text-2xl font-semibold">{i18n.t.desktop.preferences.general}</h2>
    <Card.Root data-testid="desktop-general-settings"><Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.preferences.general}<InfoHint label={i18n.t.desktop.preferences.general} text={i18n.t.desktop.preferences.generalHelp} /></Card.Title></Card.Header><Card.Content class="grid gap-4">
      <div class="flex items-center justify-between gap-3"><span class="text-sm">{i18n.t.language.label}</span><div class="flex items-center gap-2 text-sm"><span>{localeNames[i18n.locale]}</span><LanguageSwitch /></div></div>
      <div class="flex items-center justify-between gap-3"><span class="text-sm">{i18n.t.desktop.preferences.appTheme}</span><div class="flex items-center gap-2 text-sm"><span>{i18n.t.theme[userPrefersMode.current ?? "system"]}</span><ThemeToggle /></div></div>
    </Card.Content></Card.Root>
  {:else if page.url.searchParams.get("tab") === "advanced"}
    <h2 class="text-2xl font-semibold">{i18n.t.desktop.preferences.advanced}</h2>
    <Card.Root><Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.preferences.localData}<InfoHint label={i18n.t.desktop.preferences.localData} text={i18n.t.desktop.preferences.dataHelp} /></Card.Title></Card.Header><Card.Content><Button variant="outline" disabled={pending} onclick={openData} data-testid="desktop-settings-data">{i18n.t.desktop.openData}</Button>{#if failed}<p class="text-destructive mt-3 text-sm" role="alert">{i18n.t.desktop.actionFailed}</p>{/if}</Card.Content></Card.Root>
  {:else}<TerminalSettings />{/if}
</div>
