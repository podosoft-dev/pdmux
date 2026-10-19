<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { desktopActions, type DesktopAction } from "#lib/desktop.js";
  import { getI18n } from "#lib/i18n/index.js";
  import InfoHint from "#lib/dashboard/components/info-hint.svelte";
  const i18n = getI18n();
  let pending = $state(false);
  let failed = $state(false);
  async function run(action: DesktopAction): Promise<void> {
    pending = true; failed = false;
    try { const bridge = desktopActions(); if (!bridge) throw new Error("Desktop actions unavailable"); await bridge.run(action); }
    catch { failed = true; }
    finally { pending = false; }
  }
</script>
<div class="grid gap-4 p-4 sm:p-6">
  <Card.Root><Card.Header><Card.Title>{i18n.t.desktop.checkUpdates}</Card.Title></Card.Header><Card.Content><Button variant="outline" disabled={pending} onclick={() => run("check-updates")} data-testid="desktop-menu-updates">{i18n.t.desktop.checkUpdates}</Button></Card.Content></Card.Root>
  <Card.Root><Card.Header><Card.Title class="flex items-center gap-1">{i18n.t.desktop.preferences.localData}<InfoHint label={i18n.t.desktop.preferences.localData} text={i18n.t.desktop.preferences.dataHelp} /></Card.Title></Card.Header><Card.Content><Button variant="outline" disabled={pending} onclick={() => run("open-data")} data-testid="desktop-settings-data">{i18n.t.desktop.openData}</Button></Card.Content></Card.Root>
  {#if failed}<p class="text-destructive text-sm" role="alert">{i18n.t.desktop.actionFailed}</p>{/if}
</div>
