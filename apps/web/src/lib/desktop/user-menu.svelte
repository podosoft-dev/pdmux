<script lang="ts">
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import FolderIcon from "@lucide/svelte/icons/folder-open";
  import ArchiveIcon from "@lucide/svelte/icons/archive";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import { desktopActions, type DesktopAction } from "#lib/desktop.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { APP_VERSION } from "#lib/version.js";

  const i18n = getI18n();
  let pending = $state(false);
  async function run(action: DesktopAction): Promise<void> {
    pending = true;
    try { await desktopActions()?.run(action); }
    catch { toast.error(i18n.t.desktop.actionFailed); }
    finally { pending = false; }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon" class="rounded-full" title={i18n.t.desktop.localOnly} aria-label={i18n.t.dash.userMenu} data-testid="shell-user"><MonitorIcon class="size-5" /></Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" side="bottom" class="w-64" data-testid="shell-user-menu">
    <DropdownMenu.Label>{i18n.t.desktop.localOnly}</DropdownMenu.Label>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={() => goto("/settings")} data-testid="desktop-menu-settings"><SettingsIcon class="mr-2 size-4" />{i18n.t.nav.settings}</DropdownMenu.Item>
    <DropdownMenu.Item onSelect={() => goto("/connection")} data-testid="shell-server-connection"><CloudIcon class="mr-2 size-4" />{i18n.t.desktop.title}</DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item disabled={pending} onSelect={() => run("backup")} data-testid="desktop-menu-backup"><ArchiveIcon class="mr-2 size-4" />{i18n.t.desktop.createBackup}</DropdownMenu.Item>
    <DropdownMenu.Item disabled={pending} onSelect={() => run("open-data")} data-testid="desktop-menu-data"><FolderIcon class="mr-2 size-4" />{i18n.t.desktop.openData}</DropdownMenu.Item>
    <DropdownMenu.Item disabled={pending} onSelect={() => run("check-updates")} data-testid="desktop-menu-updates"><RefreshIcon class="mr-2 size-4" />{i18n.t.desktop.checkUpdates}</DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Label class="text-muted-foreground text-xs" data-testid="shell-user-version">PDMux v{APP_VERSION}</DropdownMenu.Label>
  </DropdownMenu.Content>
</DropdownMenu.Root>
