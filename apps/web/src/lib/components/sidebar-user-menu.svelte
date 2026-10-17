<script lang="ts">
  import { goto } from "$app/navigation";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Sidebar from "#lib/components/ui/sidebar/index.js";
  import AccountMenu from "./account-menu.svelte";
  import UserAvatar from "./user-avatar.svelte";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import UserIcon from "@lucide/svelte/icons/user";
  import { api } from "#lib/api.js";
  import { getI18n } from "#lib/i18n/index.js";
  import type { SessionUser } from "../../app.d.ts";

  let { user }: { user: SessionUser } = $props();
  const i18n = getI18n();
  // Outside a Sidebar.Provider, such as in an application's own shell, the
  // sidebar menu parts have no state to read, so the same identity block and
  // actions come from the shell-independent AccountMenu instead.
  const inSidebar = (Sidebar.useSidebar() as ReturnType<typeof Sidebar.useSidebar> | undefined) !== undefined;

  async function signOut(): Promise<void> {
    await api.auth.signOut();
    await goto("/", { invalidateAll: true });
  }
</script>

{#if inSidebar}
  <Sidebar.Menu>
    <Sidebar.MenuItem>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger data-testid="sidebar-user-menu">
          {#snippet child({ props })}
            <Sidebar.MenuButton {...props} size="lg" class="data-[state=open]:bg-sidebar-accent">
              <UserAvatar {user} class="size-8" />
              <div class="flex flex-col text-left text-sm leading-tight">
                <span class="truncate font-medium">{user.name}</span>
                <span class="text-muted-foreground truncate text-xs">{user.email}</span>
              </div>
              <ChevronsUpDownIcon class="ml-auto size-4" />
            </Sidebar.MenuButton>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" side="top" class="w-56">
          <DropdownMenu.Item onSelect={() => goto("/account")}><UserIcon class="mr-2 size-4" /> {i18n.t.nav.account}</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={signOut}><LogOutIcon class="mr-2 size-4" /> {i18n.t.nav.signOut}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Sidebar.MenuItem>
  </Sidebar.Menu>
{:else}
  <AccountMenu {user} variant="identity" side="top" />
{/if}
