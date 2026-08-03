<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
  let status = $state<"pending" | "ok" | "error">("pending");

  async function accept(): Promise<void> {
    const { error } = await api.auth.organization.acceptInvitation({ invitationId: page.params.id ?? "" });
    status = error ? "error" : "ok";
  }

  $effect(() => {
    void accept();
  });
</script>

<div class="mx-auto flex min-h-[60vh] max-w-md items-center">
  <Card.Root class="w-full">
    <Card.Header>
      <Card.Title>{i18n.t.acceptInvitation.title}</Card.Title>
      <Card.Description>
        {#if status === "pending"}{i18n.t.acceptInvitation.pending}
        {:else if status === "ok"}{i18n.t.acceptInvitation.ok}
        {:else}{i18n.t.acceptInvitation.error}{/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Button onclick={() => goto("/admin/organizations")}>{i18n.t.acceptInvitation.goToOrgs}</Button>
    </Card.Content>
  </Card.Root>
</div>
