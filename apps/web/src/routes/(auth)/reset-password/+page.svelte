<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
  let password = $state("");
  let confirmPassword = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);
  const token = $derived(page.url.searchParams.get("token") ?? "");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = null;
    // The token is single-use: a mistyped password here is not a retry, it is
    // another round trip through the mailbox to get a link that still works.
    if (password !== confirmPassword) {
      error = i18n.t.auth.passwordMismatch;
      return;
    }
    loading = true;
    const { error: authError } = await api.auth.resetPassword({ newPassword: password, token });
    loading = false;
    if (authError) {
      error = authError.message ?? i18n.t.auth.resetFailed;
      return;
    }
    await goto("/login", { invalidateAll: true });
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>{i18n.t.auth.newTitle}</Card.Title>
  </Card.Header>
  <Card.Content>
    <form class="flex flex-col gap-4" onsubmit={submit}>
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      {#if !token}
        <Alert.Root variant="destructive"><Alert.Description>{i18n.t.auth.missingToken}</Alert.Description></Alert.Root>
      {/if}
      <div class="flex flex-col gap-2">
        <Label for="password">{i18n.t.auth.newPassword}</Label>
        <Input id="password" type="password" bind:value={password} required autocomplete="new-password" />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="confirm-password">{i18n.t.auth.confirmNewPassword}</Label>
        <Input id="confirm-password" type="password" bind:value={confirmPassword} required autocomplete="new-password" />
      </div>
      <Button type="submit" disabled={loading || !token}>{loading ? i18n.t.auth.updating : i18n.t.auth.updatePassword}</Button>
    </form>
  </Card.Content>
</Card.Root>
