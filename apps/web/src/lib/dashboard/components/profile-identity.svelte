<script lang="ts">
  import UserAvatar from "#lib/components/user-avatar.svelte";
  import type { SessionUser } from "../../../app.d.ts";
  let { user }: { user: Pick<SessionUser, "name" | "email" | "image"> } = $props();
  // Load-bearing: CDN email obfuscation can replace a text node with an anchor and
  // decoder script between SSR and hydration, causing Svelte's positional DOM walk
  // to fail only through the CDN. No individual text node here resembles an email.
  // Do not merge these spans: HTML email_off comments do not help because Svelte
  // removes template comments before the response reaches the CDN.
  const email = $derived.by(() => {
    const at = user.email.lastIndexOf("@");
    return at > 0 ? [user.email.slice(0, at), user.email.slice(at)] : [user.email, ""];
  });
</script>
<UserAvatar {user} class="size-8 shrink-0" />
<span class="flex min-w-0 flex-col text-left leading-tight"><span class="truncate text-sm font-medium">{user.name}</span><span class="text-muted-foreground truncate text-xs">{email[0]}<span>{email[1]}</span></span></span>
