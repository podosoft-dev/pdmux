<script lang="ts">
  import { goto } from "$app/navigation";
  import QRCode from "qrcode";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
  let password = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let setup = $state<{ totpURI: string; backupCodes: string[] } | null>(null);
  let qrDataUrl = $state("");

  $effect(() => {
    const uri = setup?.totpURI;
    if (!uri) {
      qrDataUrl = "";
      return;
    }
    QRCode.toDataURL(uri, { margin: 1, width: 176 })
      .then((url) => (qrDataUrl = url))
      .catch(() => (qrDataUrl = ""));
  });

  async function begin(): Promise<void> {
    busy = true;
    error = null;
    const { data, error: e } = await api.auth.twoFactor.enable({ password });
    busy = false;
    if (e) {
      error = e.code === "INVALID_PASSWORD" ? i18n.t.setup2fa.wrongPassword : i18n.t.setup2fa.enableFailed;
      return;
    }
    setup = { totpURI: data?.totpURI ?? "", backupCodes: (data?.backupCodes ?? []) as string[] };
  }

  async function activate(): Promise<void> {
    busy = true;
    error = null;
    const { error: e } = await api.auth.twoFactor.verifyTotp({ code: code.trim() });
    busy = false;
    if (e) {
      error = i18n.t.auth.twoFactorInvalidCode;
      return;
    }
    await goto("/admin", { invalidateAll: true });
  }

  function downloadCodes(): void {
    if (!setup) return;
    const blob = new Blob([setup.backupCodes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function signOut(): Promise<void> {
    await api.auth.signOut();
    await goto("/login", { invalidateAll: true });
  }
</script>

<div class="flex min-h-svh items-center justify-center p-4">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <Card.Title>{i18n.t.setup2fa.title}</Card.Title>
      <Card.Description>{i18n.t.setup2fa.subtitle}</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}

      {#if !setup}
        <div class="flex flex-col gap-2">
          <Label for="pw">{i18n.t.setup2fa.passwordLabel}</Label>
          <Input id="pw" type="password" bind:value={password} autocomplete="current-password" />
        </div>
        <Button disabled={busy || !password} onclick={begin}>{i18n.t.setup2fa.begin}</Button>
      {:else}
        <div class="flex flex-col gap-1">
          <Label>{i18n.t.setup2fa.step1}</Label>
          {#if qrDataUrl}
            <img src={qrDataUrl} alt="TOTP QR code" width="176" height="176" class="rounded border bg-white p-2" />
          {/if}
          <code class="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">{setup.totpURI}</code>
        </div>

        <div class="flex flex-col gap-1">
          <Label>{i18n.t.setup2fa.step2}</Label>
          <p class="text-muted-foreground text-xs">{i18n.t.account.backupCodesHint}</p>
          <div class="bg-muted grid grid-cols-2 gap-1 rounded p-2 font-mono text-xs" data-testid="backup-codes">
            {#each setup.backupCodes as c (c)}<span>{c}</span>{/each}
          </div>
          <Button variant="outline" size="sm" class="w-fit" onclick={downloadCodes}>{i18n.t.account.downloadBackupCodes}</Button>
          <label class="mt-1 flex items-center gap-2 text-sm">
            <Checkbox bind:checked={saved} /> {i18n.t.setup2fa.savedConfirm}
          </label>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="code">{i18n.t.setup2fa.step3}</Label>
          <Input id="code" bind:value={code} inputmode="numeric" autocomplete="one-time-code" />
        </div>
        <Button disabled={busy || !saved || !code} onclick={activate}>{i18n.t.setup2fa.activate}</Button>
      {/if}

      <Button variant="link" class="h-auto justify-start p-0 text-xs" onclick={signOut}>{i18n.t.setup2fa.signOut}</Button>
    </Card.Content>
  </Card.Root>
</div>
