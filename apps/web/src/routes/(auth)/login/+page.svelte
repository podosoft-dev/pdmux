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
  import { getI18n, fmt } from "$lib/i18n";
  import { SIGNUP_APPROVAL_REQUIRED } from "@podosoft/podokit-api-client";
  import { site } from "$lib/site.svelte";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  // Hide the sign-up link when registration is closed from admin Settings.
  const signupOpen = $derived(site.value.allowSignup !== "false");
  let email = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let unverified = $state(false);
  let loading = $state(false);

  $effect(() => {
    if (data.oauthError === PUBLIC_SIGNUP_DISABLED) error = i18n.t.auth.publicSignupDisabled;
    else if (data.oauthError) error = i18n.t.auth.signInFailed;
  });

  // Second-factor step: a password/OTP sign-in with 2FA enabled returns
  // `twoFactorRedirect` and no session; the user then verifies with an
  // authenticator code or a backup code to complete the login.
  let twoFaRequired = $state(false);
  let twoFaCode = $state("");
  let useBackupCode = $state(false);
  let twoFaLoading = $state(false);
  const redirectTo = (): string => safeAuthRedirect(page.url.searchParams.get("redirect"));
  const authErrorCallback = (): string =>
    new URL(withAuthRedirect("/login", redirectTo()), page.url.origin).toString();
  const signupHref = (): string => withAuthRedirect("/signup", redirectTo());
  const socialProviders = $derived(data.capabilities?.providers ?? []);
  const providerLabels: Record<string, string> = {
    github: "GitHub",
    google: "Google",
    apple: "Apple",
    microsoft: "Microsoft",
  };
  const providerLabel = (provider: string): string =>
    providerLabels[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);

  async function handlePolicyError(code: string | undefined): Promise<boolean> {
    if (code === SIGNUP_APPROVAL_REQUIRED) {
      await goto("/pending-approval");
      return true;
    }
    if (code === PUBLIC_SIGNUP_DISABLED) {
      error = i18n.t.auth.publicSignupDisabled;
      return true;
    }
    return false;
  }

  async function signInSocial(provider: string): Promise<void> {
    error = null;
    const callbackURL = new URL(redirectTo(), page.url.origin).toString();
    type SocialProvider = Parameters<typeof api.auth.signIn.social>[0]["provider"];
    const { error: authError } = await api.auth.signIn.social({
      provider: provider as SocialProvider,
      callbackURL,
      errorCallbackURL: authErrorCallback(),
      newUserCallbackURL: callbackURL,
    });
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      error = authError.message ?? i18n.t.auth.signInFailed;
    }
  }

  // Returns true when 2FA is still owed (caller shows the step instead of leaving).
  function needsTwoFactor(data: unknown): boolean {
    return Boolean(data && typeof data === "object" && (data as { twoFactorRedirect?: boolean }).twoFactorRedirect);
  }

  // Map better-auth's (English) two-factor error codes to localized copy — the
  // backend returns a stable `code`, never a translated message (see i18n policy).
  function twoFactorError(code: string | undefined): string {
    switch (code) {
      case "INVALID_CODE":
      case "INVALID_BACKUP_CODE":
        return i18n.t.auth.twoFactorInvalidCode;
      case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      case "ACCOUNT_TEMPORARILY_LOCKED":
        return i18n.t.auth.twoFactorLocked;
      default:
        return i18n.t.auth.signInFailed;
    }
  }

  async function verifyTwoFactor(): Promise<void> {
    twoFaLoading = true;
    error = null;
    const { error: authError } = useBackupCode
      ? await api.auth.twoFactor.verifyBackupCode({ code: twoFaCode.trim() })
      : await api.auth.twoFactor.verifyTotp({ code: twoFaCode.trim() });
    twoFaLoading = false;
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      error = twoFactorError(authError.code);
      return;
    }
    await goto(redirectTo(), { invalidateAll: true });
  }

  // Passwordless sign-in, shown only when the server enabled the magic-link plugin.
  const magicLinkEnabled = $derived(data.capabilities?.magicLink ?? false);
  let magicLoading = $state(false);
  let magicSent = $state(false);
  async function sendMagicLink(): Promise<void> {
    if (!email) {
      error = i18n.t.auth.magicLinkNeedsEmail;
      return;
    }
    magicLoading = true;
    error = null;
    const { error: authError } = await api.auth.signIn.magicLink({
      email,
      callbackURL: new URL(redirectTo(), page.url.origin).toString(),
      errorCallbackURL: authErrorCallback(),
    });
    magicLoading = false;
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      error = authError.message ?? i18n.t.auth.signInFailed;
      return;
    }
    magicSent = true;
  }

  // Passwordless sign-in with an emailed one-time code (two steps: send, verify).
  const usernameEnabled = $derived(data.capabilities?.username ?? false);
  const emailOtpEnabled = $derived(data.capabilities?.emailOtp ?? false);
  let otpSent = $state(false);
  let otpCode = $state("");
  let otpLoading = $state(false);
  async function sendOtp(): Promise<void> {
    if (!email) {
      error = i18n.t.auth.magicLinkNeedsEmail;
      return;
    }
    otpLoading = true;
    error = null;
    const { error: authError } = await api.auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    otpLoading = false;
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      error = authError.message ?? i18n.t.auth.signInFailed;
      return;
    }
    otpSent = true;
  }
  async function verifyOtp(): Promise<void> {
    otpLoading = true;
    error = null;
    const { data, error: authError } = await api.auth.signIn.emailOtp({ email, otp: otpCode });
    otpLoading = false;
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      error = authError.message ?? i18n.t.auth.signInFailed;
      return;
    }
    if (needsTwoFactor(data)) {
      twoFaRequired = true;
      return;
    }
    await goto(redirectTo(), { invalidateAll: true });
  }

  // Passwordless sign-in with a registered passkey (WebAuthn), shown when enabled.
  const passkeyEnabled = $derived(data.capabilities?.passkey ?? false);
  let passkeyLoading = $state(false);
  async function signInWithPasskey(): Promise<void> {
    passkeyLoading = true;
    error = null;
    const res = await api.auth.signIn.passkey();
    passkeyLoading = false;
    if (res?.error) {
      if (await handlePolicyError("code" in res.error ? res.error.code : undefined)) return;
      error = res.error.message ?? i18n.t.auth.signInFailed;
      return;
    }
    await goto(redirectTo(), { invalidateAll: true });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    loading = true;
    error = null;
    unverified = false;
    // With the username plugin on, an identifier without "@" is treated as a username.
    const asUsername = usernameEnabled && !email.includes("@");
    const { data, error: authError } = asUsername
      ? await api.auth.signIn.username({ username: email, password })
      : await api.auth.signIn.email({ email, password });
    loading = false;
    if (authError) {
      if (await handlePolicyError(authError.code)) return;
      // Surface an unverified address with a path to a fresh verification link.
      unverified = authError.code === "EMAIL_NOT_VERIFIED";
      error = unverified ? i18n.t.auth.emailNotVerified : (authError.message ?? i18n.t.auth.signInFailed);
      return;
    }
    if (needsTwoFactor(data)) {
      twoFaRequired = true;
      return;
    }
    await goto(redirectTo(), { invalidateAll: true });
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>{i18n.t.auth.signInTitle}</Card.Title>
    <Card.Description>{i18n.t.auth.signInDesc}</Card.Description>
  </Card.Header>
  <Card.Content>
    {#if data.idleLogout}
      <Alert.Root data-testid="session-timeout-message" class="mb-4">
        <Alert.Description>{i18n.t.auth.idleLogout}</Alert.Description>
      </Alert.Root>
    {/if}
    {#if error}
      <Alert.Root data-testid="auth-error" variant="destructive" class="mb-4">
        <Alert.Description>
          {error}
          {#if unverified}
            <a href="/verify-email?email={encodeURIComponent(email)}" class="font-medium underline">{i18n.t.auth.resendVerification}</a>
          {/if}
        </Alert.Description>
      </Alert.Root>
    {/if}
    {#if twoFaRequired}
      <div class="flex flex-col gap-4" data-testid="two-factor-step">
        <p class="text-muted-foreground text-sm">{useBackupCode ? i18n.t.auth.twoFactorBackupPrompt : i18n.t.auth.twoFactorPrompt}</p>
        <div class="flex flex-col gap-2">
          <Label for="twofa">{useBackupCode ? i18n.t.auth.backupCodeLabel : i18n.t.auth.twoFactorCodeLabel}</Label>
          <Input
            id="twofa"
            bind:value={twoFaCode}
            inputmode={useBackupCode ? "text" : "numeric"}
            autocomplete="one-time-code"
            autofocus
          />
        </div>
        <Button type="button" disabled={twoFaLoading || !twoFaCode} onclick={verifyTwoFactor}>
          {twoFaLoading ? i18n.t.auth.signingIn : i18n.t.auth.verify}
        </Button>
        <Button
          type="button"
          variant="link"
          class="h-auto justify-start p-0 text-xs"
          onclick={() => {
            useBackupCode = !useBackupCode;
            twoFaCode = "";
            error = null;
          }}
        >
          {useBackupCode ? i18n.t.auth.twoFactorUseAuthenticator : i18n.t.auth.twoFactorUseBackup}
        </Button>
      </div>
    {:else}
    <form class="flex flex-col gap-4" onsubmit={submit}>
      <div class="flex flex-col gap-2">
        <Label for="email">{usernameEnabled ? i18n.t.auth.emailOrUsername : i18n.t.auth.email}</Label>
        <Input id="email" type={usernameEnabled ? "text" : "email"} bind:value={email} required autocomplete="username" />
      </div>
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <Label for="password">{i18n.t.auth.password}</Label>
          <a href="/forgot-password" class="text-muted-foreground text-xs hover:underline">{i18n.t.auth.forgot}</a>
        </div>
        <Input id="password" type="password" bind:value={password} required autocomplete="current-password" />
      </div>
      <Button type="submit" disabled={loading}>{loading ? i18n.t.auth.signingIn : i18n.t.auth.signIn}</Button>
    </form>
    {#if socialProviders.length > 0 || magicLinkEnabled || emailOtpEnabled || passkeyEnabled}
      <div class="mt-4 flex flex-col gap-3 border-t pt-4">
        {#each socialProviders as provider (provider)}
          <Button type="button" variant="outline" class="w-full" onclick={() => signInSocial(provider)}>
            {fmt(i18n.t.auth.continueWith, { provider: providerLabel(provider) })}
          </Button>
        {/each}
        {#if passkeyEnabled}
          <Button type="button" variant="outline" class="w-full" disabled={passkeyLoading} onclick={signInWithPasskey}>
            {passkeyLoading ? i18n.t.auth.signingIn : i18n.t.auth.passkeyButton}
          </Button>
        {/if}
        {#if magicLinkEnabled}
          {#if magicSent}
            <p class="text-muted-foreground text-sm" data-testid="magic-link-sent">{i18n.t.auth.magicLinkSent}</p>
          {:else}
            <Button type="button" variant="outline" class="w-full" disabled={magicLoading} onclick={sendMagicLink}>
              {magicLoading ? i18n.t.auth.sending : i18n.t.auth.magicLinkButton}
            </Button>
          {/if}
        {/if}
        {#if emailOtpEnabled}
          {#if otpSent}
            <div class="flex flex-col gap-2">
              <Label for="otp">{i18n.t.auth.otpCode}</Label>
              <Input id="otp" bind:value={otpCode} inputmode="numeric" autocomplete="one-time-code" />
              <Button type="button" class="w-full" disabled={otpLoading || !otpCode} onclick={verifyOtp}>
                {otpLoading ? i18n.t.auth.signingIn : i18n.t.auth.otpVerify}
              </Button>
            </div>
          {:else}
            <Button type="button" variant="outline" class="w-full" disabled={otpLoading} onclick={sendOtp}>
              {otpLoading ? i18n.t.auth.sending : i18n.t.auth.otpButton}
            </Button>
          {/if}
        {/if}
      </div>
    {/if}
    {/if}
  </Card.Content>
  {#if signupOpen}
    <Card.Footer class="justify-center">
      <p class="text-muted-foreground text-sm">{i18n.t.auth.noAccount} <a href={signupHref()} class="text-foreground hover:underline">{i18n.t.auth.signUp}</a></p>
    </Card.Footer>
  {/if}
</Card.Root>
