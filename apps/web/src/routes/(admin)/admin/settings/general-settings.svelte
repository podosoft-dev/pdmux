<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
  import * as Card from "$lib/components/ui/card";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api";
  import { getI18n } from "$lib/i18n";
  import { defaultLocale, LOCALES, localeNames, resolveLocale } from "$lib/i18n/messages";
  import { site, type SiteSettings } from "$lib/site.svelte";

  const i18n = getI18n();
  const t = $derived(i18n.t.general);

  // Text fields, seeded from the current site settings.
  const s = $derived(site.value);
  let form = $state({
    name: "",
    description: "",
    supportEmail: "",
    footerText: "",
    termsUrl: "",
    privacyUrl: "",
    locale: defaultLocale,
    timezone: "",
  });
  let maintenanceMode = $state(false);
  let allowSignup = $state(true);
  let seeded = $state(false);
  $effect(() => {
    if (seeded || !site.initialized) return;
    form = {
      name: s.name ?? "",
      description: s.description ?? "",
      supportEmail: s.supportEmail ?? "",
      footerText: s.footerText ?? "",
      termsUrl: s.termsUrl ?? "",
      privacyUrl: s.privacyUrl ?? "",
      locale: resolveLocale(s.locale),
      timezone: s.timezone ?? "",
    };
    maintenanceMode = s.maintenanceMode === "true";
    allowSignup = s.allowSignup !== "false";
    seeded = true;
  });

  let saving = $state(false);
  async function save(): Promise<void> {
    saving = true;
    try {
      const payload: Record<string, string> = {
        ...form,
        maintenanceMode: String(maintenanceMode),
        allowSignup: String(allowSignup),
      };
      await api.put("/site/settings", payload);
      site.patch(payload as Partial<SiteSettings>); // live: browser title updates now
      toast.success(t.saved);
    } catch {
      toast.error(t.saveError);
    } finally {
      saving = false;
    }
  }

  const ICON_TYPES = ".svg,.png,.ico";
  let uploading = $state(false);
  /**
   * The field's own value, cleared after every attempt so picking the SAME file twice
   * still fires `change` (the browser suppresses it when the selection is unchanged).
   *
   * ⚠ It is a binding, not `input.value = ""`. `Input` binds `value` internally, so an
   * imperative write leaves Svelte's copy holding the old `C:\fakepath\…` — and the next
   * render (this component re-renders on `site.patch`, two lines below) would write that
   * string back to a file input, which throws `InvalidStateError`.
   */
  let faviconValue = $state("");
  const faviconSrc = $derived(
    s.hasFavicon ? `/api/site/favicon?v=${s.faviconVersion ?? ""}` : "/favicon.svg",
  );
  async function uploadFavicon(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.error(t.iconTooBig);
      faviconValue = "";
      return;
    }
    uploading = true;
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/site/favicon", { method: "POST", body });
      if (!res.ok) throw new Error(String(res.status));
      const { version } = (await res.json()) as { version: string | null };
      site.patch({ hasFavicon: true, faviconVersion: version }); // live: favicon refetches
      toast.success(t.iconSaved);
    } catch {
      toast.error(t.iconError);
    } finally {
      uploading = false;
      faviconValue = "";
    }
  }
</script>

<div class="flex flex-col gap-6">
  <div class="grid items-start gap-6 lg:grid-cols-2">
    <Card.Root>
    <Card.Header>
      <Card.Title>{t.brandingTitle}</Card.Title>
      <Card.Description>{t.brandingDesc}</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="site-name">{t.siteName}</Label>
        <Input id="site-name" bind:value={form.name} placeholder={t.siteNamePlaceholder} />
        <p class="text-muted-foreground text-xs">{t.siteNameHint}</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label>{t.favicon}</Label>
        <div class="flex items-center gap-3">
          <img src={faviconSrc} alt="favicon" class="bg-muted size-12 rounded-md border p-1" />
          <div class="flex flex-col gap-1.5">
            <!-- The shadcn `Input` handles `type="file"` itself, so the field gets the
                 same border, focus ring and disabled treatment as every other control
                 on this page instead of a hand-written `file:` chip. -->
            <Input
              type="file"
              bind:value={faviconValue}
              accept={ICON_TYPES}
              disabled={uploading}
              onchange={uploadFavicon}
              class="file:mr-3"
            />
            <p class="text-muted-foreground text-xs">{t.faviconHint}</p>
          </div>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root class="lg:row-span-2">
    <Card.Header>
      <Card.Title>{t.infoTitle}</Card.Title>
      <Card.Description>{t.infoDesc}</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <Label for="site-desc">{t.description}</Label>
        <Input id="site-desc" bind:value={form.description} placeholder={t.descriptionPlaceholder} />
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <Label for="support-email">{t.supportEmail}</Label>
          <Input id="support-email" type="email" bind:value={form.supportEmail} placeholder="support@example.com" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="footer">{t.footerText}</Label>
          <Input id="footer" bind:value={form.footerText} placeholder="© 2026 Example" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="terms">{t.termsUrl}</Label>
          <Input id="terms" bind:value={form.termsUrl} placeholder="/terms" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="privacy">{t.privacyUrl}</Label>
          <Input id="privacy" bind:value={form.privacyUrl} placeholder="/privacy" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="locale">{t.locale}</Label>
          <Select.Root type="single" bind:value={form.locale}>
            <Select.Trigger id="locale" class="w-full">
              {localeNames[form.locale] ?? form.locale ?? ""}
            </Select.Trigger>
            <Select.Content>
              {#each LOCALES as locale (locale)}
                <Select.Item value={locale}>{localeNames[locale] ?? locale}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="timezone">{t.timezone}</Label>
          <Input id="timezone" bind:value={form.timezone} placeholder="UTC" />
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>{t.opsTitle}</Card.Title>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col">
          <Label>{t.maintenance}</Label>
          <p class="text-muted-foreground text-sm">{t.maintenanceDesc}</p>
        </div>
        <Switch bind:checked={maintenanceMode} aria-label={t.maintenance} />
      </div>
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col">
          <Label>{t.allowSignup}</Label>
          <p class="text-muted-foreground text-sm">{t.allowSignupDesc}</p>
        </div>
        <Switch bind:checked={allowSignup} aria-label={t.allowSignup} />
      </div>
    </Card.Content>
  </Card.Root>
  </div>

  <div>
    <Button onclick={save} disabled={saving}>{saving ? t.saving : t.save}</Button>
  </div>
</div>
