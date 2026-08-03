<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { api } from "$lib/api";
  import { PUBLIC_SIGNUP_DISABLED } from "$lib/auth-errors";
  import { safeAuthRedirect, withAuthRedirect } from "$lib/auth-redirect";
  import { getI18n } from "$lib/i18n";
  import { SIGNUP_APPROVAL_REQUIRED } from "@podosoft/podokit-api-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let confirmPassword = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);
  const redirectTo = (): string => safeAuthRedirect(page.url.searchParams.get("redirect"));

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = null;
    // Before the request, not after: a typo here costs the account. Sign-up is the
    // one password entry with no way back — the address is not verified yet, so the
    // reset link that would rescue it goes somewhere the user cannot read.
    if (password !== confirmPassword) {
      error = i18n.t.auth.passwordMismatch;
      return;
    }
    loading = true;
    // callbackURL: where the verification link lands once confirmed (absolute so
    // it returns to the web app, not the API origin). Ignored when verification is off.
    const { error: authError } = await api.auth.signUp.email({
      name,
      email,
      password,
      callbackURL: new URL(redirectTo(), page.url.origin).toString(),
    });
    if (authError) {
      loading = false;
      if (authError.code === SIGNUP_APPROVAL_REQUIRED) {
        await goto("/pending-approval");
        return;
      }
      if (authError.code === PUBLIC_SIGNUP_DISABLED) {
        error = i18n.t.auth.publicSignupDisabled;
        return;
      }
      error = authError.message ?? i18n.t.auth.signUpFailed;
      return;
    }
    // When email verification is required, sign-up creates no session — send the
    // user to confirm their address instead of into the (guarded) app.
    const { data: session } = await api.auth.getSession();
    loading = false;
    if (!session?.session) {
      if (data.capabilities?.signupApprovalRequired) {
        await goto("/pending-approval");
        return;
      }
      await goto(`/verify-email?email=${encodeURIComponent(email)}`);
      return;
    }
    await goto(redirectTo(), { invalidateAll: true });
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>{i18n.t.auth.createTitle}</Card.Title>
    <Card.Description>{i18n.t.auth.createDesc}</Card.Description>
  </Card.Header>
  <Card.Content>
    <form class="flex flex-col gap-4" onsubmit={submit}>
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      <div class="flex flex-col gap-2">
        <Label for="name">{i18n.t.auth.name}</Label>
        <Input id="name" bind:value={name} required autocomplete="name" />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="email">{i18n.t.auth.email}</Label>
        <Input id="email" type="email" bind:value={email} required autocomplete="email" />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="password">{i18n.t.auth.password}</Label>
        <Input id="password" type="password" bind:value={password} required autocomplete="new-password" />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="confirm-password">{i18n.t.auth.confirmPassword}</Label>
        <Input id="confirm-password" type="password" bind:value={confirmPassword} required autocomplete="new-password" />
      </div>
      <Button type="submit" disabled={loading}>{loading ? i18n.t.auth.creating : i18n.t.auth.create}</Button>
    </form>
  </Card.Content>
  <Card.Footer class="justify-center">
    <p class="text-muted-foreground text-sm">{i18n.t.auth.haveAccount} <a href={withAuthRedirect("/login", redirectTo())} class="text-foreground hover:underline">{i18n.t.auth.signIn}</a></p>
  </Card.Footer>
</Card.Root>
