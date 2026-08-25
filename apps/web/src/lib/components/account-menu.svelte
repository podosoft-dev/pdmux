<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { currentPath, withAuthRedirect } from "#lib/auth-redirect.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import UserIcon from "@lucide/svelte/icons/user";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import { api } from "#lib/api.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { cn } from "#lib/utils.js";
  import type { SessionUser } from "../../app.d.ts";
  import UserAvatar from "./user-avatar.svelte";

  type MenuSide = "top" | "right" | "bottom" | "left";
  type MenuAlign = "start" | "center" | "end";
  type Props = {
    user: SessionUser | null;
    variant?: "avatar" | "identity";
    side?: MenuSide;
    align?: MenuAlign;
    class?: string;
  };

  let {
    user,
    variant = "avatar",
    side = "bottom",
    align = "end",
    class: className,
  }: Props = $props();
  const i18n = getI18n();
  const loginHref = $derived(withAuthRedirect("/login", currentPath(page.url)));

  async function signOut(): Promise<void> {
    const returnTo = currentPath(page.url);
    await api.auth.signOut();
    await goto(returnTo, { invalidateAll: true });
  }
</script>

{#if user}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      data-testid="account-menu"
      class={cn(
        "hover:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-3",
        variant === "avatar"
          ? "inline-flex size-8 items-center justify-center rounded-full"
          : "flex w-full items-center gap-2 rounded-md p-2 text-left",
        className,
      )}
      aria-label={i18n.t.nav.account}
    >
      <UserAvatar {user} class="size-8" />
      {#if variant === "identity"}
        <div class="min-w-0 flex-1 text-sm leading-tight">
          <span class="block truncate font-medium">{user.name}</span>
          <span class="text-muted-foreground block truncate text-xs">{user.email}</span>
        </div>
        <ChevronsUpDownIcon class="size-4 shrink-0" />
      {/if}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content {align} {side} class="w-56">
      <DropdownMenu.Label>
        <span class="block truncate font-medium">{user.name}</span>
        <span class="text-muted-foreground block truncate text-xs font-normal">{user.email}</span>
      </DropdownMenu.Label>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => goto("/account")}><UserIcon class="mr-2 size-4" /> {i18n.t.nav.account}</DropdownMenu.Item>
      {#if user.role === "admin"}
        <DropdownMenu.Item onSelect={() => goto("/admin")}><LayoutDashboardIcon class="mr-2 size-4" /> {i18n.t.common.appName}</DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item data-testid="sign-out" onSelect={signOut}><LogOutIcon class="mr-2 size-4" /> {i18n.t.nav.signOut}</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <Button data-testid="sign-in-link" href={loginHref} variant="ghost" class={className}>{i18n.t.auth.signIn}</Button>
{/if}
