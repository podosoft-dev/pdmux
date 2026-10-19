<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import ServerIcon from "@lucide/svelte/icons/server";
  import SlidersIcon from "@lucide/svelte/icons/sliders-horizontal";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import { getI18n } from "#lib/i18n/index.js";

  // Shared by web and desktop profile menus, with the API's existing fleet permission.
  let { canManage }: { canManage: boolean } = $props();
  const i18n = getI18n();
</script>

{#if canManage}
  <DropdownMenu.Item
    onSelect={() => goto("/hosts")}
    data-testid="nav-hosts"
    aria-current={page.url.pathname.startsWith("/hosts") ? "page" : undefined}
    class="aria-[current=page]:bg-accent"
  ><ServerIcon class="mr-2 size-4" /> {i18n.t.dash.hostsLink}</DropdownMenu.Item>
  <DropdownMenu.Item
    onSelect={() => goto("/settings")}
    data-testid="nav-settings"
    aria-current={page.url.pathname.startsWith("/settings") ? "page" : undefined}
    class="aria-[current=page]:bg-accent"
  ><SlidersIcon class="mr-2 size-4" /> {i18n.t.dash.fleet.title}</DropdownMenu.Item>
{/if}
<!-- Members can still manage their own read-only coding access. -->
<DropdownMenu.Item
  onSelect={() => goto("/access")}
  data-testid="nav-access"
  aria-current={page.url.pathname.startsWith("/access") ? "page" : undefined}
  class="aria-[current=page]:bg-accent"
><KeyRoundIcon class="mr-2 size-4" /> {i18n.t.dash.mcpTokens.title}</DropdownMenu.Item>
