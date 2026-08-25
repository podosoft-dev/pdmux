<script lang="ts">
  import { page } from "$app/state";
  import * as Sidebar from "#lib/components/ui/sidebar/index.js";
  import SidebarUserMenu from "./sidebar-user-menu.svelte";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import UsersIcon from "@lucide/svelte/icons/users";
  import MonitorSmartphoneIcon from "@lucide/svelte/icons/monitor-smartphone";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import Building2Icon from "@lucide/svelte/icons/building-2";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import HouseIcon from "@lucide/svelte/icons/house";
  import { getI18n } from "#lib/i18n/index.js";
  import { moduleNavEntries, type AdminNavEntry } from "#lib/admin/registry.svelte.js";
  import type { SessionUser } from "../../app.d.ts";

  let { user, capabilities }: { user: SessionUser; capabilities?: { auditLog?: boolean; organization?: boolean } } = $props();
  const i18n = getI18n();

  type NavItem = AdminNavEntry;
  const items = $derived<NavItem[]>([
    { href: "/admin", label: (t) => t.nav.overview, icon: LayoutDashboardIcon },
    { href: "/admin/users", label: (t) => t.nav.users, icon: UsersIcon, adminOnly: true },
    { href: "/admin/sessions", label: (t) => t.nav.sessions, icon: MonitorSmartphoneIcon, adminOnly: true },
    ...(capabilities?.organization
      ? [{ href: "/admin/organizations", label: (t) => t.nav.organizations, icon: Building2Icon, adminOnly: true } as NavItem]
      : []),
    ...(capabilities?.auditLog
      ? [{ href: "/admin/audit", label: (t) => t.nav.audit, icon: ScrollTextIcon, adminOnly: true } as NavItem]
      : []),
    // Module-contributed entries (present only for installed modules).
    ...moduleNavEntries,
    { href: "/admin/settings", label: (t) => t.nav.settings, icon: SettingsIcon, adminOnly: true },
  ]);
  const visible = $derived(items.filter((item) => !item.adminOnly || user.role === "admin"));
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
