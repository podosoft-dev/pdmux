<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { api } from "#lib/api.js";
  import { getI18n } from "#lib/i18n/index.js";

  const i18n = getI18n();
  let email = $state("");
  let sent = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    loading = true;
    error = null;
    // Absolute URL: the emailed link hits the API to validate, then redirects
    // here (the web app) with a valid token — a relative path would resolve
    // against the API origin.
    const { error: authError } = await api.auth.requestPasswordReset({
      email,
      redirectTo: `${page.url.origin}/reset-password`,
    });
    loading = false;
    if (authError) {
      error = authError.message ?? i18n.t.auth.requestFailed;
      return;
    }
    sent = true;
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>{i18n.t.auth.resetTitle}</Card.Title>
    <Card.Description>{i18n.t.auth.resetDesc}</Card.Description>
  </Card.Header>
  <Card.Content>
    {#if sent}
      <Alert.Root><Alert.Description>{i18n.t.auth.resetSent}</Alert.Description></Alert.Root>
    {:else}
      <form class="flex flex-col gap-4" onsubmit={submit}>
        {#if error}
          <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
        {/if}
        <div class="flex flex-col gap-2">
          <Label for="email">{i18n.t.auth.email}</Label>
          <Input id="email" type="email" bind:value={email} required autocomplete="email" />
        </div>
        <Button type="submit" disabled={loading}>{loading ? i18n.t.auth.sending : i18n.t.auth.sendReset}</Button>
      </form>
    {/if}
  </Card.Content>
  <Card.Footer class="justify-center">
    <a href="/login" class="text-muted-foreground text-sm hover:underline">{i18n.t.auth.backToSignIn}</a>
  </Card.Footer>
</Card.Root>
