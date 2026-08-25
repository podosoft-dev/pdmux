<script lang="ts">
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { toast } from "svelte-sonner";

  let { email }: { email: string } = $props();
  const i18n = getI18n();

  async function stopImpersonating(): Promise<void> {
    const { error } = await api.auth.admin.stopImpersonating();
    if (error) {
      toast.error(i18n.t.users.actionFailed);
      return;
    }
    await goto("/admin", { invalidateAll: true });
  }
</script>

<div class="bg-primary text-primary-foreground flex items-center justify-between gap-2 px-4 py-2 text-sm">
  <span>{i18n.t.users.impersonatingAs.replace("{email}", email)}</span>
  <Button variant="secondary" size="sm" onclick={stopImpersonating}>{i18n.t.users.stopImpersonating}</Button>
</div>
