<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import UserAvatar from "#lib/components/user-avatar.svelte";
  import ProfileIdentity from "#lib/dashboard/components/profile-identity.svelte";
  import UserIcon from "@lucide/svelte/icons/user";
  import LogInIcon from "@lucide/svelte/icons/log-in";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import ShellNavigationMenu from "#lib/dashboard/components/shell-navigation-menu.svelte";
  import { desktopConnection, type DesktopStatusView } from "#lib/desktop.js";
  import { useShellState } from "#lib/dashboard/shell-state.svelte.ts";
  import { getI18n } from "#lib/i18n/index.js";
  import { APP_VERSION } from "#lib/version.js";
  let { desktopStatus }: { desktopStatus: DesktopStatusView; user?: unknown; canManage?: boolean } = $props();
  const i18n = getI18n();
  const shell = useShellState();
  let status = $state(untrack(() => desktopStatus));
  const user = $derived(status.connected ? status.user : null);
  const admin = $derived(user?.role?.split(",").map(role => role.trim()).includes("admin") ?? false);
  let loginOpen = $state(false);
  let busy = $state(false);
  let failed = $state(false);
  let code = $state("");
  let refreshing = false;
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch("/api/desktop/status");
      if (!response.ok) return;
      const next = await response.json() as DesktopStatusView;
      const changed = next.connected !== status.connected || next.user?.id !== status.user?.id || next.scopeId !== status.scopeId || next.serverUrl !== status.serverUrl;
      status = next;
      if (status.connected && status.user) { loginOpen = false; code = ""; }
      if (changed) { await invalidateAll(); await shell.feed.refresh(); }
    } catch { /* A local restart does not replace the last known account with an anonymous one. */ }
    finally { refreshing = false; }
  }
  onMount(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 3_000);
    const unsubscribe = desktopConnection()?.onChanged?.(() => { void refresh(); });
    return () => { clearInterval(interval); unsubscribe?.(); };
  });
  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true; failed = false;
    try { await action(); await refresh(); }
    catch { failed = true; toast.error(i18n.t.desktop.failed); }
    finally { busy = false; }
  }
  async function signIn(): Promise<void> {
    loginOpen = true;
    await run(async () => { const bridge = desktopConnection(); if (!bridge) throw new Error("Desktop login unavailable"); await bridge.connect(); });
  }
  async function closeLogin(): Promise<void> {
    if (busy) return;
    loginOpen = false; code = "";
    if (!status.connected) await run(async () => { await desktopConnection()?.disconnect(); });
  }
  function openAccount(page: "account" | "admin"): void {
    void run(async () => { await desktopConnection()?.open(page); });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon" class="rounded-full" title={user?.name ?? i18n.t.desktop.profile.signedOut} aria-label={i18n.t.dash.userMenu} data-testid="shell-user">{#if user}<UserAvatar {user} class="size-6" />{:else}<span class="bg-muted flex size-6 items-center justify-center rounded-full"><UserIcon class="size-4" /></span>{/if}</Button>{/snippet}</DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" side="bottom" class="w-64" data-testid="shell-user-menu">
    {#if user}<DropdownMenu.Label class="flex items-center gap-2 py-1.5 font-normal" data-testid="shell-user-identity"><ProfileIdentity {user} /></DropdownMenu.Label>
    {:else}<DropdownMenu.Label class="text-muted-foreground font-normal">{i18n.t.desktop.profile.signedOut}</DropdownMenu.Label><DropdownMenu.Item disabled={busy} onSelect={signIn} data-testid="shell-user-signin"><LogInIcon class="mr-2 size-4" />{i18n.t.desktop.profile.signIn}</DropdownMenu.Item>{/if}
    <DropdownMenu.Separator />
    <ShellNavigationMenu />
    {#if user}
      <DropdownMenu.Item disabled={busy} onSelect={() => openAccount("account")} data-testid="shell-user-account"><UserIcon class="mr-2 size-4" />{i18n.t.nav.account}</DropdownMenu.Item>
      {#if admin}<DropdownMenu.Item disabled={busy} onSelect={() => openAccount("admin")} data-testid="shell-user-admin"><ShieldIcon class="mr-2 size-4" />{i18n.t.dash.adminConsole}</DropdownMenu.Item>{/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item disabled={busy} onSelect={() => run(async () => { await desktopConnection()?.disconnect(); })} data-testid="shell-user-signout"><LogOutIcon class="mr-2 size-4" />{i18n.t.nav.signOut}</DropdownMenu.Item>
    {/if}
    <DropdownMenu.Separator />
    <DropdownMenu.Label class="text-muted-foreground text-xs font-normal" data-testid="shell-user-version">PDMux v{APP_VERSION}</DropdownMenu.Label>
  </DropdownMenu.Content>
</DropdownMenu.Root>
<Dialog.Root open={loginOpen} onOpenChange={open => { if (!open) void closeLogin(); }}>
  <Dialog.Content class="sm:max-w-lg" onInteractOutside={event => event.preventDefault()} onEscapeKeydown={event => { if (busy) event.preventDefault(); }} data-testid="desktop-login-dialog">
    <Dialog.Header><Dialog.Title>{i18n.t.desktop.profile.browserTitle}</Dialog.Title><Dialog.Description>{i18n.t.desktop.profile.browserHelp}</Dialog.Description></Dialog.Header>
    {#if failed}<p class="text-destructive text-sm" role="alert">{i18n.t.desktop.failed}</p>{/if}
    <div class="grid gap-2"><Label for="profile-auth-code">{i18n.t.desktop.code}</Label><Input id="profile-auth-code" bind:value={code} autocomplete="off" disabled={busy} /></div>
    <Dialog.Footer><Button variant="outline" disabled={busy} onclick={closeLogin}>{i18n.t.settingsDialog.cancel}</Button>{#if failed}<Button disabled={busy} onclick={signIn}>{i18n.t.desktop.profile.openBrowser}</Button>{:else}<Button disabled={busy || code.length < 32} onclick={() => run(async () => { await desktopConnection()?.authenticate(code); })}>{i18n.t.desktop.complete}</Button>{/if}</Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
