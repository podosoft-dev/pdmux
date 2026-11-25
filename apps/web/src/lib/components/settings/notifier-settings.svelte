<script lang="ts">
  import { toast } from "svelte-sonner";
  import { api } from "#lib/api.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Switch } from "#lib/components/ui/switch/index.js";
  import { getI18n } from "#lib/i18n/index.js";

  // Operator notifications (notifier module). The notifier manifest registers
  // this tab only when the module is installed. Secrets are write-only: the API
  // reports whether one is stored, and a blank field keeps it.
  type NotifierView = {
    pushover: { enabled: boolean; hasToken: boolean; hasUserKey: boolean };
    email: { enabled: boolean; recipients: string[] };
    webhook: { enabled: boolean; hasUrl: boolean };
  };
  type ChannelResult = { channel: string; ok: boolean; skipped: boolean; error?: string };

  const i18n = getI18n();
  const t = $derived(i18n.t.settings.notifier);
  let config = $state<NotifierView | null>(null);
  let pushoverEnabled = $state(false);
  let emailEnabled = $state(false);
  let webhookEnabled = $state(false);
  let token = $state("");
  let userKey = $state("");
  let recipients = $state("");
  let webhookUrl = $state("");
  let busy = $state(false);
  let results = $state<ChannelResult[] | null>(null);

  function apply(view: NotifierView): void {
    config = view;
    pushoverEnabled = view.pushover.enabled;
    emailEnabled = view.email.enabled;
    webhookEnabled = view.webhook.enabled;
    recipients = view.email.recipients.join(", ");
    token = "";
    userKey = "";
    webhookUrl = "";
  }

  async function refresh(): Promise<void> {
    try {
      apply(await api.get<NotifierView>("/admin/notifier/config"));
    } catch {
      toast.error(t.loadFailed);
    }
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      const view = await api.put<NotifierView>("/admin/notifier/config", {
        pushover: {
          enabled: pushoverEnabled,
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(userKey.trim() ? { userKey: userKey.trim() } : {}),
        },
        email: {
          enabled: emailEnabled,
          recipients: recipients.split(",").map((entry) => entry.trim()).filter(Boolean),
        },
        webhook: {
          enabled: webhookEnabled,
          ...(webhookUrl.trim() ? { url: webhookUrl.trim() } : {}),
        },
      });
      apply(view);
      toast.success(t.saved);
    } catch {
      toast.error(t.saveFailed);
    } finally {
      busy = false;
    }
  }

  async function sendTest(): Promise<void> {
    busy = true;
    try {
      const result = await api.post<{ ok: boolean; channels: ChannelResult[] }>("/admin/notifier/test");
      results = result.channels;
      if (result.ok) toast.success(t.testSent);
      else toast.error(t.testNothingSent);
    } catch {
      results = null;
      toast.error(t.testFailed);
    } finally {
      busy = false;
    }
  }

  function channelName(channel: string): string {
    if (channel === "pushover") return t.pushoverTitle;
    if (channel === "email") return t.emailTitle;
    if (channel === "webhook") return t.webhookTitle;
    return channel;
  }

  function secretPlaceholder(stored: boolean | undefined): string {
    return stored ? t.secretSaved : t.secretMissing;
  }

  $effect(() => {
    void refresh();
  });
</script>

<section class="flex flex-col gap-4" data-testid="notifier-settings">
  <div>
    <h2 class="text-lg font-semibold">{t.title}</h2>
    <p class="text-muted-foreground text-sm">{t.subtitle}</p>
  </div>

  <div class="grid gap-4 lg:grid-cols-3">
    <Card.Root data-channel="pushover">
      <Card.Header>
        <div class="flex items-start justify-between gap-3">
          <div>
            <Card.Title>{t.pushoverTitle}</Card.Title>
            <Card.Description>{t.pushoverDescription}</Card.Description>
          </div>
          <Switch aria-label={t.pushoverTitle} bind:checked={pushoverEnabled} disabled={busy || !config} />
        </div>
      </Card.Header>
      <Card.Content class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="notifier-pushover-token">{t.pushoverToken}</Label>
          <Input
            id="notifier-pushover-token"
            type="password"
            autocomplete="off"
            placeholder={secretPlaceholder(config?.pushover.hasToken)}
            bind:value={token}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="notifier-pushover-user">{t.pushoverUserKey}</Label>
          <Input
            id="notifier-pushover-user"
            type="password"
            autocomplete="off"
            placeholder={secretPlaceholder(config?.pushover.hasUserKey)}
            bind:value={userKey}
          />
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root data-channel="email">
      <Card.Header>
        <div class="flex items-start justify-between gap-3">
          <div>
            <Card.Title>{t.emailTitle}</Card.Title>
            <Card.Description>{t.emailDescription}</Card.Description>
          </div>
          <Switch aria-label={t.emailTitle} bind:checked={emailEnabled} disabled={busy || !config} />
        </div>
      </Card.Header>
      <Card.Content class="flex flex-col gap-1.5">
        <Label for="notifier-email-recipients">{t.emailRecipients}</Label>
        <Input
          id="notifier-email-recipients"
          type="text"
          inputmode="email"
          autocomplete="off"
          placeholder="ops@example.com"
          bind:value={recipients}
        />
        <p class="text-muted-foreground text-xs">{t.emailRecipientsHint}</p>
      </Card.Content>
    </Card.Root>

    <Card.Root data-channel="webhook">
      <Card.Header>
        <div class="flex items-start justify-between gap-3">
          <div>
            <Card.Title>{t.webhookTitle}</Card.Title>
            <Card.Description>{t.webhookDescription}</Card.Description>
          </div>
          <Switch aria-label={t.webhookTitle} bind:checked={webhookEnabled} disabled={busy || !config} />
        </div>
      </Card.Header>
      <Card.Content class="flex flex-col gap-1.5">
        <Label for="notifier-webhook-url">{t.webhookUrl}</Label>
        <Input
          id="notifier-webhook-url"
          type="password"
          autocomplete="off"
          placeholder={secretPlaceholder(config?.webhook.hasUrl)}
          bind:value={webhookUrl}
        />
      </Card.Content>
    </Card.Root>
  </div>

  <p class="text-muted-foreground text-sm">{t.secretHelp}</p>

  <div class="flex flex-wrap justify-end gap-2">
    <Button variant="outline" disabled={busy || !config} onclick={sendTest}>{t.sendTest}</Button>
    <Button disabled={busy || !config} onclick={save}>{t.save}</Button>
  </div>

  {#if results}
    <Card.Root data-testid="notifier-test-results">
      <Card.Header>
        <Card.Title>{t.resultsTitle}</Card.Title>
      </Card.Header>
      <Card.Content>
        <ul class="flex flex-col gap-2">
          {#each results as result (result.channel)}
            <li class="flex flex-wrap items-center gap-2 text-sm" data-result-channel={result.channel}>
              <span class="min-w-24 font-medium">{channelName(result.channel)}</span>
              <Badge variant={result.ok ? "secondary" : result.skipped ? "outline" : "destructive"}>
                {result.ok ? t.resultSent : result.skipped ? t.resultSkipped : t.resultFailed}
              </Badge>
              {#if result.error}
                <span class="text-muted-foreground break-all">{result.error}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </Card.Content>
    </Card.Root>
  {/if}
</section>
