<script lang="ts">
  import * as Avatar from "$lib/components/ui/avatar";
  import type { SessionUser } from "../../app.d.ts";

  let { user, class: className }: { user: Pick<SessionUser, "name" | "email" | "image">; class?: string } = $props();
  const initials = $derived((user.name || user.email || "?").slice(0, 2).toUpperCase());
</script>

<Avatar.Root class={className}>
  {#if user.image}<Avatar.Image src={user.image} alt={user.name} />{/if}
  <Avatar.Fallback>{initials}</Avatar.Fallback>
</Avatar.Root>
