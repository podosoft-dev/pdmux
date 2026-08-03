<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { api } from "$lib/api";
  import { fmt, getI18n } from "$lib/i18n";

  const i18n = getI18n();
  // ?email from the sign-up redirect; ?error when the API bounces a bad/expired link here.
  let email = $state(page.url.searchParams.get("email") ?? "");
  const linkError = $derived(page.url.searchParams.get("error"));
  let sent = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function resend(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    loading = true;
    error = null;
    const { error: authError } = await api.auth.sendVerificationEmail({
      email,
      callbackURL: `${page.url.origin}/admin`,
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
    <Card.Title>{i18n.t.auth.verifyTitle}</Card.Title>
    <Card.Description>{email ? fmt(i18n.t.auth.verifyDesc, { email }) : i18n.t.auth.verifyDescNoEmail}</Card.Description>
  </Card.Header>
  <Card.Content>
    {#if linkError}
      <Alert.Root variant="destructive" class="mb-4"><Alert.Description>{i18n.t.auth.verifyLinkError}</Alert.Description></Alert.Root>
    {/if}
    {#if sent}
      <Alert.Root><Alert.Description>{i18n.t.auth.verifySent}</Alert.Description></Alert.Root>
    {:else}
      <form class="flex flex-col gap-4" onsubmit={resend}>
        {#if error}
          <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
        {/if}
        <div class="flex flex-col gap-2">
          <Label for="email">{i18n.t.auth.email}</Label>
          <Input id="email" type="email" bind:value={email} required autocomplete="email" />
        </div>
        <Button type="submit" disabled={loading || !email}>{loading ? i18n.t.auth.sending : i18n.t.auth.resendVerification}</Button>
      </form>
    {/if}
  </Card.Content>
  <Card.Footer class="justify-center">
    <a href="/login" class="text-muted-foreground text-sm hover:underline">{i18n.t.auth.backToSignIn}</a>
  </Card.Footer>
</Card.Root>
