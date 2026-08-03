<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { Badge } from "$lib/components/ui/badge";
  import { Switch } from "$lib/components/ui/switch";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import GeneralSettings from "./general-settings.svelte";
  import AppearanceCard from "$lib/components/settings/appearance-card.svelte";
  import { moduleSettingsSections } from "$lib/admin/registry.svelte";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api";
  import { fmt, getI18n } from "$lib/i18n";
  import type { Capabilities } from "@podosoft/podokit-api-client";
  import type { AuthConfigView, SocialProviderView } from "./+page.server";

  let { data }: { data: { capabilities: Capabilities; authConfig: AuthConfigView | null; require2fa: boolean } } = $props();
  const i18n = getI18n();
  const caps = $derived(data.capabilities);
  const ac = $derived(data.authConfig);

  type EditableFlag = "twoFactor" | "magicLink" | "emailOtp" | "username" | "multiSession" | "phoneNumber" | "apiKey" | "passkey" | "organization" | "oidcProvider";
  // require2fa is a policy flag stored alongside the feature flags but not part of
  // the typed Capabilities, so it is toggled but never read from `caps`.
  type ToggleFlag = EditableFlag | "require2fa";
  type ServerKey = "requireEmailVerification" | "requireSignupApproval" | "hibp" | "allowDelete" | "auditLog";

  // Every card renders from this one shape, so they share size and structure: a
  // title (+ optional enable switch), a description, and a footer with a status
  // badge and optional configure action.
  type Item = {
    key: string;
    name: string;
    desc: string;
    status: { on: boolean; label: string };
    toggle?: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void };
    configure?: { label: string; onClick: () => void };
  };

  let saving = $state(false);
  // Writes DB-backed auth config (OAuth providers, SMTP, server toggles) — applied
  // live (the auth instance rebuilds on the next request), no restart.
  async function put(body: unknown): Promise<boolean> {
    saving = true;
    let ok = false;
    try {
      await api.put("/account/auth-config", body);
      await invalidateAll();
      toast.success(i18n.t.settings.saved);
      ok = true;
    } catch {
      toast.error(i18n.t.settings.saveFailed);
    }
    saving = false;
    return ok;
  }
  // Feature flags live in a separate store (app_setting) with their own endpoint.
  async function toggleFlag(flag: ToggleFlag, next: boolean): Promise<void> {
    saving = true;
    try {
      await api.put("/account/settings", { [flag]: next });
      await invalidateAll();
      toast.success(i18n.t.settings.saved);
    } catch {
      toast.error(i18n.t.settings.saveFailed);
    }
    saving = false;
  }

  const callbackBase = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const providerCallback = (id: string): string => `${callbackBase}/api/auth/callback/${id}`;
  const labelOf = (id: string): string => ac?.catalog.find((c) => c.id === id)?.label ?? id;
  const configured = $derived(Object.values(ac?.social ?? {}));
  const enabledProviders = $derived(configured.filter((p) => p.enabled && p.clientId && p.hasSecret));
  const configuredIds = $derived(new Set(Object.keys(ac?.social ?? {})));
  const addable = $derived((ac?.catalog ?? []).filter((p) => !configuredIds.has(p.id)));

  function socialStatus(v: SocialProviderView): { on: boolean; label: string } {
    if (v.enabled && v.clientId && v.hasSecret) return { on: true, label: i18n.t.settings.enabled };
    if (v.clientId || v.hasSecret || v.enabled) return { on: false, label: i18n.t.settings.configuredOff };
    return { on: false, label: i18n.t.settings.notConfigured };
  }
  const socialCardStatus = $derived<{ on: boolean; label: string }>(
    enabledProviders.length > 0
      ? { on: true, label: enabledProviders.map((p) => labelOf(p.id)).join(", ") }
      : { on: false, label: configured.length > 0 ? i18n.t.settings.configuredOff : i18n.t.settings.notConfigured },
  );

  // ── Dialogs. Secret fields are write-only; leaving them blank keeps the stored
  //    secret. The Social login dialog manages every provider (list ⇄ add/edit
  //    form) in one popup. ──
  let openDialog = $state<"social" | "smtp" | "sessionIdle" | null>(null);
  let socialView = $state<"list" | "form">("list");
  let socialForm = $state({ id: "", clientId: "", clientSecret: "", redirectURI: "", enabled: true, adding: false });
  let smtp = $state({ enabled: false, host: "", port: 587, secure: false, user: "", from: "", pass: "" });
  let sessionIdleTimeoutMinutes = $state(30);
  $effect(() => {
    if (!ac) return;
    smtp = { enabled: ac.smtp.enabled, host: ac.smtp.host, port: ac.smtp.port, secure: ac.smtp.secure, user: ac.smtp.user, from: ac.smtp.from, pass: "" };
    sessionIdleTimeoutMinutes = ac.server.sessionIdleTimeoutMinutes ?? 30;
  });
  const sessionIdleTimeoutValid = $derived(
    Number.isInteger(Number(sessionIdleTimeoutMinutes))
      && Number(sessionIdleTimeoutMinutes) >= 5
      && Number(sessionIdleTimeoutMinutes) <= 10_080,
  );
  const editingView = $derived(socialForm.adding ? undefined : ac?.social[socialForm.id]);

  function socialRedirectURI(): string {
    const configured = socialForm.redirectURI.trim();
    return socialForm.adding || !configured ? providerCallback(socialForm.id) : configured;
  }

  function openSocialManager(): void {
    socialView = "list";
    openDialog = "social";
  }
  function startEditSocial(id: string): void {
    const v = ac?.social[id];
    socialForm = { id, clientId: v?.clientId ?? "", clientSecret: "", redirectURI: v?.redirectURI ?? "", enabled: v?.enabled ?? true, adding: false };
    socialView = "form";
  }
  function startAddSocial(): void {
    socialForm = { id: addable[0]?.id ?? "", clientId: "", clientSecret: "", redirectURI: "", enabled: true, adding: true };
    socialView = "form";
  }
  async function saveSocial(): Promise<void> {
    if (!socialForm.id) return;
    const done = await put({
      social: {
        [socialForm.id]: {
          enabled: socialForm.enabled,
          clientId: socialForm.clientId,
          redirectURI: socialRedirectURI(),
          ...(socialForm.clientSecret ? { clientSecret: socialForm.clientSecret } : {}),
        },
      },
    });
    if (done) socialView = "list"; // back to the list; keep the dialog open to add more
  }
  async function removeSocial(id: string): Promise<void> {
    await put({ social: { [id]: { delete: true } } });
  }
  async function saveSmtp(): Promise<void> {
    const done = await put({ smtp: { enabled: smtp.enabled, host: smtp.host, port: Number(smtp.port), secure: smtp.secure, user: smtp.user, from: smtp.from, ...(smtp.pass ? { pass: smtp.pass } : {}) } });
    if (done) openDialog = null;
  }
  async function toggleSessionIdle(enabled: boolean): Promise<void> {
    await put({
      server: {
        sessionIdleTimeoutMinutes: enabled
          ? (ac?.server.sessionIdleTimeoutMinutes ?? 30)
          : null,
      },
    });
  }
  async function saveSessionIdleTimeout(): Promise<void> {
    if (!sessionIdleTimeoutValid) return;
    const done = await put({
      server: { sessionIdleTimeoutMinutes: Number(sessionIdleTimeoutMinutes) },
    });
    if (done) openDialog = null;
  }

  // ── Card builders (uniform Item shape) ──
  const flagCard = (flag: EditableFlag, name: string, desc: string): Item => ({
    key: `flag-${flag}`,
    name,
    desc,
    status: { on: caps[flag], label: caps[flag] ? i18n.t.settings.enabled : i18n.t.settings.disabled },
    toggle: { checked: caps[flag], disabled: saving, onChange: (v) => toggleFlag(flag, v) },
  });
  const serverCard = (key: ServerKey, name: string, desc: string, on: boolean): Item => ({
    key: `srv-${key}`,
    name,
    desc,
    status: { on, label: on ? i18n.t.settings.enabled : i18n.t.settings.disabled },
    toggle: { checked: on, disabled: saving || !ac, onChange: (v) => put({ server: { [key]: v } }) },
  });

  const signInMethods = $derived<Item[]>([
    { key: "emailPassword", name: i18n.t.settings.emailPassword, desc: i18n.t.settings.emailPasswordDesc, status: { on: true, label: i18n.t.settings.enabled } },
    // A single Social login card; providers (Google, GitHub, Apple, …) are added,
    // edited and removed dynamically inside its dialog.
    { key: "social", name: i18n.t.settings.socialTitle, desc: i18n.t.settings.socialCardDesc, status: socialCardStatus, configure: { label: i18n.t.settings.configure, onClick: openSocialManager } },
    flagCard("magicLink", i18n.t.settings.magicLink, i18n.t.settings.magicLinkDesc),
    flagCard("emailOtp", i18n.t.settings.emailOtp, i18n.t.settings.emailOtpDesc),
    flagCard("username", i18n.t.settings.username, i18n.t.settings.usernameDesc),
    flagCard("passkey", i18n.t.settings.passkey, i18n.t.settings.passkeyDesc),
    flagCard("phoneNumber", i18n.t.settings.phoneNumber, i18n.t.settings.phoneNumberDesc),
    flagCard("multiSession", i18n.t.settings.multiSession, i18n.t.settings.multiSessionDesc),
  ]);
  // SMTP delivery is configured inside the email-verification card (its "SMTP
  // settings" popup): verification needs outbound mail, so they live together.
  const emailSettings = $derived<Item[]>([
    {
      key: "email",
      name: i18n.t.settings.emailVerification,
      desc: i18n.t.settings.emailVerificationDesc,
      status: { on: caps.emailVerification, label: caps.emailVerification ? i18n.t.settings.enabled : i18n.t.settings.disabled },
      toggle: { checked: caps.emailVerification, disabled: saving || !ac, onChange: (v) => put({ server: { requireEmailVerification: v } }) },
      configure: { label: i18n.t.settings.smtpConfigure, onClick: () => (openDialog = "smtp") },
    },
  ]);
  const security = $derived<Item[]>([
    serverCard(
      "requireSignupApproval",
      i18n.t.settings.signupApproval,
      i18n.t.settings.signupApprovalDesc,
      caps.signupApprovalRequired,
    ),
    flagCard("twoFactor", i18n.t.settings.twoFactor, i18n.t.settings.twoFactorDesc),
    {
      key: "flag-require2fa",
      name: i18n.t.settings.require2fa,
      desc: i18n.t.settings.require2faDesc,
      status: { on: data.require2fa, label: data.require2fa ? i18n.t.settings.enabled : i18n.t.settings.disabled },
      // Only meaningful when 2FA itself is on; disabled otherwise.
      toggle: { checked: data.require2fa, disabled: saving || !caps.twoFactor, onChange: (v) => toggleFlag("require2fa", v) },
    },
    {
      key: "session-idle-timeout",
      name: i18n.t.settings.autoLogout,
      desc: i18n.t.settings.autoLogoutDesc,
      status: ac?.server.sessionIdleTimeoutMinutes
        ? {
            on: true,
            label: fmt(i18n.t.settings.autoLogoutMinutes, {
              minutes: ac.server.sessionIdleTimeoutMinutes,
            }),
          }
        : { on: false, label: i18n.t.settings.disabled },
      toggle: {
        checked: ac?.server.sessionIdleTimeoutMinutes !== null && ac?.server.sessionIdleTimeoutMinutes !== undefined,
        disabled: saving || !ac,
        onChange: toggleSessionIdle,
      },
      configure: {
        label: i18n.t.settings.configure,
        onClick: () => (openDialog = "sessionIdle"),
      },
    },
    serverCard("hibp", i18n.t.settings.breachCheck, i18n.t.settings.breachCheckDesc, caps.passwordBreachCheck),
    serverCard("allowDelete", i18n.t.settings.accountDeletion, i18n.t.settings.accountDeletionDesc, caps.deleteAccount),
    serverCard("auditLog", i18n.t.settings.auditLog, i18n.t.settings.auditLogDesc, caps.auditLog),
  ]);
  const advanced = $derived<Item[]>([
    flagCard("apiKey", i18n.t.settings.apiKey, i18n.t.settings.apiKeyDesc),
    flagCard("organization", i18n.t.settings.organization, i18n.t.settings.organizationDesc),
    flagCard("oidcProvider", i18n.t.settings.oidcProvider, i18n.t.settings.oidcProviderDesc),
  ]);
  const sections = $derived([
    { title: i18n.t.settings.signInTitle, subtitle: i18n.t.settings.signInSubtitle, items: signInMethods },
    { title: i18n.t.settings.emailTitle, subtitle: i18n.t.settings.emailSubtitle, items: emailSettings },
    { title: i18n.t.settings.securityTitle, subtitle: i18n.t.settings.securitySubtitle, items: security },
    { title: i18n.t.settings.advancedTitle, subtitle: i18n.t.settings.advancedSubtitle, items: advanced },
  ]);
</script>

{#snippet statusBadge(on: boolean, label: string)}
  <Badge variant={on ? "secondary" : "outline"} class="max-w-full gap-1.5">
    <span class={`size-1.5 shrink-0 rounded-full ${on ? "bg-green-500" : "bg-muted-foreground/40"}`}></span><span class="truncate">{label}</span>
  </Badge>
{/snippet}

{#snippet card(item: Item)}
  <Card.Root class="flex min-h-[8.5rem] flex-col gap-2 p-4">
    <div class="flex items-start justify-between gap-3">
      <span class="font-medium">{item.name}</span>
      {#if item.toggle}
        {@const t = item.toggle}
        <Switch aria-label={item.name} checked={t.checked} disabled={t.disabled} onCheckedChange={(v) => t.onChange(v === true)} class="shrink-0" />
      {/if}
    </div>
    <p class="text-muted-foreground flex-1 text-sm">{item.desc}</p>
    <div class="mt-auto flex items-center justify-between gap-2 pt-1">
      {@render statusBadge(item.status.on, item.status.label)}
      {#if item.configure}
        {@const c = item.configure}
        <Button variant="outline" size="sm" class="shrink-0" disabled={!ac} onclick={c.onClick}>{c.label}</Button>
      {/if}
    </div>
  </Card.Root>
{/snippet}

<div class="flex flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">{i18n.t.settings.title}</h1>
    <p class="text-muted-foreground text-sm">{i18n.t.settings.subtitle}</p>
  </div>

  <Tabs.Root value="general">
    <Tabs.List>
      <Tabs.Trigger value="general">{i18n.t.general.tab}</Tabs.Trigger>
      <Tabs.Trigger value="appearance">{i18n.t.general.appearanceTitle}</Tabs.Trigger>
      <Tabs.Trigger value="auth">{i18n.t.settings.tab}</Tabs.Trigger>
      {#each moduleSettingsSections as s (s.value)}
        <Tabs.Trigger value={s.value}>{s.label(i18n.t)}</Tabs.Trigger>
      {/each}
    </Tabs.List>

    <Tabs.Content value="general" class="mt-6">
      <GeneralSettings />
    </Tabs.Content>

    <Tabs.Content value="appearance" class="mt-6">
      <AppearanceCard />
    </Tabs.Content>

    <Tabs.Content value="auth" class="mt-6 flex flex-col gap-6">
      {#each sections as section (section.title)}
        <section class="flex flex-col gap-3">
          <div>
            <h2 class="text-lg font-semibold">{section.title}</h2>
            <p class="text-muted-foreground text-sm">{section.subtitle}</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each section.items as item (item.key)}
              {@render card(item)}
            {/each}
          </div>
        </section>
      {/each}
    </Tabs.Content>

    {#each moduleSettingsSections as s (s.value)}
      <Tabs.Content value={s.value} class="mt-6">
        <s.component />
      </Tabs.Content>
    {/each}
  </Tabs.Root>
</div>

<!-- Social login: manage every provider (list ⇄ add/edit form) in one dialog -->
<Dialog.Root open={openDialog === "social"} onOpenChange={(v) => { if (!v) openDialog = null; }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{i18n.t.settings.socialTitle}</Dialog.Title>
      <Dialog.Description>{socialView === "list" ? i18n.t.settings.socialSubtitle : i18n.t.settings.socialDialogDesc}</Dialog.Description>
    </Dialog.Header>

    {#if socialView === "list"}
      <div class="flex flex-col gap-2">
        {#if configured.length === 0}
          <p class="text-muted-foreground py-2 text-sm">{i18n.t.settings.noProviders}</p>
        {/if}
        {#each configured as p (p.id)}
          {@const st = socialStatus(p)}
          <div class="flex items-center gap-3 rounded-md border p-3">
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="font-medium">{labelOf(p.id)}</span>
              {@render statusBadge(st.on, st.label)}
            </div>
            <Switch aria-label={labelOf(p.id)} checked={p.enabled} disabled={saving} onCheckedChange={(v) => put({ social: { [p.id]: { enabled: v === true } } })} class="shrink-0" />
            <Button variant="outline" size="sm" class="shrink-0" onclick={() => startEditSocial(p.id)}>{i18n.t.settings.edit}</Button>
            <Button variant="ghost" size="sm" class="text-muted-foreground shrink-0" disabled={saving} onclick={() => removeSocial(p.id)}>{i18n.t.settings.remove}</Button>
          </div>
        {/each}
      </div>
      <Dialog.Footer class="sm:justify-between">
        <Button onclick={startAddSocial} disabled={addable.length === 0}>{i18n.t.settings.addProvider}</Button>
        <Button variant="outline" onclick={() => (openDialog = null)}>{i18n.t.settings.close}</Button>
      </Dialog.Footer>
    {:else}
      <div class="flex flex-col gap-3">
        {#if socialForm.adding}
          <div class="flex flex-col gap-1">
            <Label for="social-provider">{i18n.t.settings.provider}</Label>
            <Select.Root type="single" bind:value={socialForm.id}>
              <Select.Trigger id="social-provider" class="w-full">
                {addable.find((p) => p.id === socialForm.id)?.label ?? i18n.t.settings.provider}
              </Select.Trigger>
              <Select.Content>
                {#each addable as p (p.id)}
                  <Select.Item value={p.id} label={p.label}>{p.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
        <label class="flex items-center justify-between gap-3 text-sm font-medium">{i18n.t.settings.smtpEnabled}<Switch aria-label={i18n.t.settings.smtpEnabled} bind:checked={socialForm.enabled} /></label>
        <div class="flex flex-col gap-1"><Label for="social-id">{i18n.t.settings.clientId}</Label><Input id="social-id" bind:value={socialForm.clientId} autocomplete="off" /></div>
        <div class="flex flex-col gap-1"><Label for="social-secret">{i18n.t.settings.clientSecret}</Label><Input id="social-secret" type="password" bind:value={socialForm.clientSecret} autocomplete="off" placeholder={editingView?.hasSecret ? i18n.t.settings.secretSet : ""} /></div>
        {#if socialForm.id}
          <p class="text-muted-foreground text-xs">{i18n.t.settings.redirectUri}: <code class="break-all">{socialRedirectURI()}</code></p>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (socialView = "list")}>{i18n.t.settings.back}</Button>
        <Button disabled={saving || !socialForm.id} onclick={saveSocial}>{i18n.t.settings.save}</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<!-- Sliding session expiration — enforced by better-auth and mirrored by the browser timer. -->
<Dialog.Root open={openDialog === "sessionIdle"} onOpenChange={(v) => { if (!v) openDialog = null; }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{i18n.t.settings.autoLogout}</Dialog.Title>
      <Dialog.Description>{i18n.t.settings.autoLogoutDialogDesc}</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <Label for="session-idle-timeout">{i18n.t.settings.autoLogoutField}</Label>
      <Input
        id="session-idle-timeout"
        type="number"
        min="5"
        max="10080"
        step="1"
        bind:value={sessionIdleTimeoutMinutes}
      />
      <p class="text-muted-foreground text-xs">{i18n.t.settings.autoLogoutHint}</p>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (openDialog = null)}>{i18n.t.settings.cancel}</Button>
      <Button disabled={saving || !sessionIdleTimeoutValid} onclick={saveSessionIdleTimeout}>{i18n.t.settings.save}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- SMTP (email delivery) dialog — reached from the email-verification card -->
<Dialog.Root open={openDialog === "smtp"} onOpenChange={(v) => { if (!v) openDialog = null; }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{i18n.t.settings.smtpTitle}</Dialog.Title>
      <Dialog.Description>{i18n.t.settings.smtpSubtitle}</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-3">
      <label class="flex items-center justify-between gap-3 text-sm font-medium">{i18n.t.settings.smtpEnabled}<Switch aria-label={i18n.t.settings.smtpEnabled} bind:checked={smtp.enabled} /></label>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1"><Label for="smtp-host">{i18n.t.settings.smtpHost}</Label><Input id="smtp-host" bind:value={smtp.host} autocomplete="off" /></div>
        <div class="flex flex-col gap-1"><Label for="smtp-port">{i18n.t.settings.smtpPort}</Label><Input id="smtp-port" type="number" bind:value={smtp.port} /></div>
        <div class="flex flex-col gap-1"><Label for="smtp-user">{i18n.t.settings.smtpUser}</Label><Input id="smtp-user" bind:value={smtp.user} autocomplete="off" /></div>
        <div class="flex flex-col gap-1"><Label for="smtp-pass">{i18n.t.settings.smtpPass}</Label><Input id="smtp-pass" type="password" bind:value={smtp.pass} autocomplete="off" placeholder={ac?.smtp.hasSecret ? i18n.t.settings.secretSet : ""} /></div>
        <div class="flex flex-col gap-1"><Label for="smtp-from">{i18n.t.settings.smtpFrom}</Label><Input id="smtp-from" bind:value={smtp.from} autocomplete="off" /></div>
        <label class="flex items-center gap-2 self-end pb-2 text-sm"><Switch aria-label={i18n.t.settings.smtpSecure} bind:checked={smtp.secure} />{i18n.t.settings.smtpSecure}</label>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (openDialog = null)}>{i18n.t.settings.cancel}</Button>
      <Button disabled={saving} onclick={saveSmtp}>{i18n.t.settings.save}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
