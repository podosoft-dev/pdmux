<script lang="ts">
  import { page } from "$app/state";
  import * as Sidebar from "#lib/components/ui/sidebar/index.js";
  import SidebarUserMenu from "./sidebar-user-menu.svelte";
  import HouseIcon from "@lucide/svelte/icons/house";
  import { getI18n } from "#lib/i18n/index.js";
  import { adminNavEntries } from "#lib/admin/nav.js";
  import type { SessionUser } from "../../app.d.ts";

  let { user, capabilities }: { user: SessionUser; capabilities?: { auditLog?: boolean; organization?: boolean } } = $props();
  const i18n = getI18n();

  const visible = $derived(adminNavEntries(capabilities, user.role));
</script>

<Sidebar.Root collapsible="icon">
  <Sidebar.Header>
    <div
      data-testid="sidebar-brand"
      class="flex items-center gap-2 overflow-hidden px-2 py-1 font-semibold whitespace-nowrap group-data-[collapsible=icon]:hidden"
    >
      {i18n.t.common.appName}
    </div>
  </Sidebar.Header>
  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.Menu>
        {#each visible as item (item.href)}
          <Sidebar.MenuItem>
            <Sidebar.MenuButton isActive={page.url.pathname === item.href} tooltipContent={item.label(i18n.t)}>
              {#snippet child({ props })}
                <a href={item.href} {...props}>
                  <item.icon />
                  <span>{item.label(i18n.t)}</span>
                </a>
              {/snippet}
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        {/each}
      </Sidebar.Menu>
    </Sidebar.Group>
  </Sidebar.Content>
  <Sidebar.Footer>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton tooltipContent={i18n.t.nav.home}>
          {#snippet child({ props })}
            <a href="/" {...props}>
              <HouseIcon />
              <span>{i18n.t.nav.home}</span>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
    <SidebarUserMenu {user} />
  </Sidebar.Footer>
</Sidebar.Root>
