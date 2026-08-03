<script lang="ts">
  /**
   * Who is signed in — an avatar in the sidebar's control row, beside the theme switch.
   *
   * WHY AN AVATAR AND NOT A BLOCK: it used to be a name-plus-address row pinned to the
   * bottom of the column, and it cost ~52px of a column whose entire job is to hold host
   * cards. Nobody needs telling which account they are signed in as on every paint — it
   * is a question asked once, and a menu is where an answer to a rare question belongs.
   * So the identity moved INTO the menu (name, address, and the same routes), and what
   * stays on screen is the one pixel-cheap thing that still answers "am I me?" at a
   * glance: the avatar. The row it joins already exists, so this costs no height at all.
   *
   * WHY IT IS NOT PodoKit's `sidebar-user-menu.svelte`: that component is built from
   * shadcn's `Sidebar.*` primitives, which read a `Sidebar.Provider` context this shell
   * does not have (our sidebar is `@pdmux/ui`'s viewport-bound column, not the platform
   * console's collapsible one). Rendering it here would throw. It is a `managed` file,
   * so it is neither edited nor forked — the pieces that carry no context (the avatar)
   * are reused, and the trigger is rebuilt from the same dropdown primitive with the
   * same routes and the same message keys.
   */
  import { goto } from "$app/navigation";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import UserAvatar from "$lib/components/user-avatar.svelte";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import UserIcon from "@lucide/svelte/icons/user";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";
  import { APP_VERSION } from "$lib/version";
  import type { SessionUser } from "../../../app.d.ts";

  let { user }: { user: SessionUser } = $props();

  /**
   * The address, split so that NO SINGLE TEXT NODE looks like an email address.
   *
   * ⚠ THIS IS LOAD-BEARING, NOT A STYLE CHOICE. A CDN in front of a self-hosted pdmux
   * may rewrite email addresses it finds in the HTML it serves — replacing the text
   * with an anchor plus a decoder script — one large CDN ships this as "email address
   * obfuscation" and has it ON BY DEFAULT. That mutates the DOM between what the server
   * rendered and what the client hydrates against, and Svelte's hydration walks that
   * tree positionally: it dies with `Failed to hydrate: Cannot read properties of
   * undefined`, the page paints once and then goes blank.
   *
   * The failure appears ONLY through the CDN, never on localhost, and no amount of
   * cache clearing touches it — which is what made it cost an afternoon (2026-07-27).
   * Splitting the value defeats every such rewriter without asking the operator to turn
   * a CDN feature off, and renders identically: two inline spans, no gap, and a copy
   * still yields the whole address.
   *
   * `<!--email_off-->`, the documented opt-out, does NOT work here — Svelte strips
   * template comments from its output, so the marker never reaches the browser.
   */
  const emailParts = $derived.by(() => {
    const at = user.email.lastIndexOf("@");
    return at > 0 ? { local: user.email.slice(0, at), domain: user.email.slice(at) } : { local: user.email, domain: "" };
  });
  const i18n = getI18n();

  /**
   * The way into the platform console — the only one left, now that the account page's
   * standalone header is gone.
   *
   * Same predicate PodoKit's own sidebar uses (`app-sidebar.svelte`), so "administrator"
   * means one thing in this app. It is presentation only: a member who types `/admin`
   * still meets PodoKit's guard.
   */
  const isAdmin = $derived(user.role === "admin");

  async function signOut(): Promise<void> {
    await api.auth.signOut();
    await goto("/", { invalidateAll: true });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- `size="icon"` and `rounded-full`: it sits between the language and theme
           switches, so it matches their 32px box, and the round frame is what says
           "this one is a person" in a row of square glyph buttons.

           `title` carries the name because the name no longer has a place on screen —
           a pointer can still ask who this is without opening anything. The label is
           the translated one, since a screen reader needs to know it is a MENU; the
           name it announces comes from the identity block once the menu is open. -->
      <Button
        {...props}
        variant="ghost"
        size="icon"
        class="rounded-full"
        title={user.name}
        aria-label={i18n.t.dash.userMenu}
        data-testid="shell-user"
      >
        <UserAvatar {user} class="size-6" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <!-- Downwards now, and aligned to its end: the trigger sits at the TOP of the column
       and near its right edge, so the panel hangs below it and stays inside the sidebar
       rather than reaching across the terminals. -->
  <DropdownMenu.Content align="end" side="bottom" class="w-56" data-testid="shell-user-menu">
    <!-- The identity the trigger gave up. It is a `Label`, not an `Item`: it answers a
         question, nothing here is clickable. -->
    <DropdownMenu.Label class="flex items-center gap-2 py-1.5 font-normal" data-testid="shell-user-identity">
      <UserAvatar {user} class="size-8 shrink-0" />
      <span class="flex min-w-0 flex-col text-left leading-tight">
        <span class="truncate text-sm font-medium">{user.name}</span>
        <!-- Split on purpose — see `emailParts`. Do not collapse back into one node. -->
        <span class="text-muted-foreground truncate text-xs"
          >{emailParts.local}<span>{emailParts.domain}</span></span
        >
      </span>
    </DropdownMenu.Label>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={() => goto("/account")} data-testid="shell-user-account">
      <UserIcon class="mr-2 size-4" /> {i18n.t.nav.account}
    </DropdownMenu.Item>
    {#if isAdmin}
      <DropdownMenu.Item onSelect={() => goto("/admin")} data-testid="shell-user-admin">
        <ShieldIcon class="mr-2 size-4" /> {i18n.t.dash.adminConsole}
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={signOut} data-testid="shell-user-signout">
      <LogOutIcon class="mr-2 size-4" /> {i18n.t.nav.signOut}
    </DropdownMenu.Item>
    <!-- Which pdmux this is. It belongs here rather than on a card because it is the
         SERVER's version, not any host's — a host's agent has its own, and the two
         are released independently (REQ-PDAGENT-020).

         No i18n key: the content is a proper noun and a SemVer, so there is nothing
         to translate and a key would only add four identical strings. `Label` and
         not `Item` because it answers a question rather than doing anything —
         nothing here is clickable. -->
    <DropdownMenu.Separator />
    <DropdownMenu.Label
      class="text-muted-foreground py-1 text-xs font-normal"
      data-testid="shell-user-version"
    >
      pdmux v{APP_VERSION}
    </DropdownMenu.Label>
  </DropdownMenu.Content>
</DropdownMenu.Root>
