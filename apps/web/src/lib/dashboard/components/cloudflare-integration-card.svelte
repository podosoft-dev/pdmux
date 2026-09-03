<script lang="ts">
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { cloudflareApi, errorCode } from "#lib/dashboard/api.js";
  import { getI18n } from "#lib/i18n/index.js";
  import type {
    CloudflareDiscoveryView,
    CloudflareIntegrationView,
  } from "#lib/dashboard/types.js";
  import ConfirmDialog from "./confirm-dialog.svelte";

  let { canManage }: { canManage: boolean } = $props();
  const i18n = getI18n();
  let connection = $state<CloudflareIntegrationView | null>(null);
  let loading = $state(true);
  let token = $state("");
  let discovery = $state<CloudflareDiscoveryView | null>(null);
  let zoneId = $state("");
  let policyId = $state("");
  let baseDomain = $state("");
  let discovering = $state(false);
  let connecting = $state(false);
  let disconnectOpen = $state(false);

  const zone = $derived(discovery?.zones.find((candidate) => candidate.id === zoneId) ?? null);
  const policies = $derived(
    discovery?.policies.filter((policy) => policy.accountId === zone?.accountId) ?? [],
  );

  onMount(() => {
    void cloudflareApi.get()
      .then((value) => (connection = value))
      .catch(() => {})
      .finally(() => (loading = false));
  });

  function failure(cause: unknown): string {
    const code = errorCode(cause);
    if (code === "CLOUDFLARE_IN_USE") return i18n.t.dash.cloudflare.error.inUse;
    if (code === "FORBIDDEN") return i18n.t.dash.error.forbidden;
    if (code === "NETWORK_ERROR") return i18n.t.dash.error.offline;
    return i18n.t.dash.cloudflare.error.generic;
  }

  async function discover(): Promise<void> {
    if (!token.trim()) return;
    discovering = true;
    try {
      discovery = await cloudflareApi.discover(token.trim());
      const first = discovery.zones[0];
      zoneId = first?.id ?? "";
      baseDomain = first?.name ?? "";
      policyId = discovery.policies.find((policy) => policy.accountId === first?.accountId)?.id ?? "";
    } catch (cause: unknown) {
      toast.error(failure(cause));
    } finally {
      discovering = false;
    }
  }

  function selectZone(value: string): void {
    zoneId = value;
    const selected = discovery?.zones.find((candidate) => candidate.id === value);
    if (!selected) return;
    baseDomain = selected.name;
    policyId = discovery?.policies.find((policy) => policy.accountId === selected.accountId)?.id ?? "";
  }

  async function connect(): Promise<void> {
    if (!token.trim() || !zoneId || !policyId || !baseDomain.trim()) return;
    connecting = true;
    try {
      connection = await cloudflareApi.connect({
        apiToken: token.trim(),
        zoneId,
        baseDomain: baseDomain.trim(),
        accessPolicyId: policyId,
      });
      token = "";
      discovery = null;
      toast.success(i18n.t.dash.cloudflare.connectedToast);
    } catch (cause: unknown) {
      toast.error(failure(cause));
    } finally {
      connecting = false;
    }
  }

  async function disconnect(): Promise<void> {
    try {
      await cloudflareApi.disconnect();
      connection = null;
      toast.success(i18n.t.dash.cloudflare.disconnectedToast);
    } catch (cause: unknown) {
      toast.error(failure(cause));
      throw cause;
    }
  }
</script>

<Card.Root class="shrink-0" data-testid="cloudflare-integration">
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <CloudIcon class="size-4" aria-hidden="true" />
      {i18n.t.dash.cloudflare.title}
    </Card.Title>
    <Card.Description>{i18n.t.dash.cloudflare.subtitle}</Card.Description>
    {#if connection}
      <Card.Action><Badge variant="outline">{i18n.t.dash.cloudflare.connected}</Badge></Card.Action>
    {/if}
  </Card.Header>
  <Card.Content class="grid gap-4">
    {#if loading}
      <p class="text-muted-foreground text-sm">{i18n.t.dash.cloudflare.loading}</p>
    {:else if connection}
      <div class="grid gap-3 text-sm sm:grid-cols-2" data-testid="cloudflare-summary">
        <div>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.zone}</p>
          <p class="font-medium">{connection.zoneName}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.baseDomain}</p>
          <p class="font-medium">{connection.baseDomain}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.policy}</p>
          <p class="font-medium">{connection.accessPolicyName}</p>
        </div>
      </div>
      <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.dedicatedTunnelNote}</p>
      {#if canManage}
        <div><Button variant="destructive" size="sm" onclick={() => (disconnectOpen = true)} data-testid="cloudflare-disconnect">{i18n.t.dash.cloudflare.disconnect}</Button></div>
      {/if}
    {:else if canManage}
      <div class="grid gap-2">
        <Label for="cloudflare-token">{i18n.t.dash.cloudflare.apiToken}</Label>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Input
            id="cloudflare-token"
            type="password"
            autocomplete="off"
            bind:value={token}
            placeholder={i18n.t.dash.cloudflare.apiTokenPlaceholder}
            data-testid="cloudflare-token"
          />
          <Button variant="outline" disabled={!token.trim() || discovering} onclick={discover} data-testid="cloudflare-discover">
            {discovering ? i18n.t.dash.cloudflare.discovering : i18n.t.dash.cloudflare.discover}
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.permissions}</p>
      </div>
      {#if discovery}
        <div class="grid gap-4 sm:grid-cols-2" data-testid="cloudflare-discovery">
          <div class="grid gap-1.5">
            <Label for="cloudflare-zone">{i18n.t.dash.cloudflare.zone}</Label>
            <Select.Root type="single" value={zoneId} onValueChange={selectZone}>
              <Select.Trigger id="cloudflare-zone" data-testid="cloudflare-zone">{zone?.name ?? i18n.t.dash.cloudflare.chooseZone}</Select.Trigger>
              <Select.Content>
                {#each discovery.zones as candidate (candidate.id)}
                  <Select.Item value={candidate.id}>{candidate.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="grid gap-1.5">
            <Label for="cloudflare-policy">{i18n.t.dash.cloudflare.policy}</Label>
            <Select.Root type="single" bind:value={policyId}>
              <Select.Trigger id="cloudflare-policy" data-testid="cloudflare-policy">
                {policies.find((policy) => policy.id === policyId)?.name ?? i18n.t.dash.cloudflare.choosePolicy}
              </Select.Trigger>
              <Select.Content>
                {#each policies as policy (policy.id)}
                  <Select.Item value={policy.id}>{policy.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="grid gap-1.5 sm:col-span-2">
            <Label for="cloudflare-domain">{i18n.t.dash.cloudflare.baseDomain}</Label>
            <Input id="cloudflare-domain" bind:value={baseDomain} data-testid="cloudflare-domain" />
            <p class="text-muted-foreground text-xs">{i18n.t.dash.cloudflare.baseDomainHint}</p>
          </div>
          <div class="sm:col-span-2">
            <Button disabled={!zoneId || !policyId || !baseDomain.trim() || connecting} onclick={connect} data-testid="cloudflare-connect">
              {connecting ? i18n.t.dash.cloudflare.connecting : i18n.t.dash.cloudflare.connect}
            </Button>
          </div>
        </div>
      {/if}
    {:else}
      <p class="text-muted-foreground text-sm">{i18n.t.dash.cloudflare.readOnly}</p>
    {/if}
  </Card.Content>
</Card.Root>

<ConfirmDialog
  bind:open={disconnectOpen}
  title={i18n.t.dash.cloudflare.disconnectTitle}
  warning={i18n.t.dash.cloudflare.disconnectWarning}
  label="Cloudflare"
  confirmLabel={i18n.t.dash.cloudflare.disconnect}
  testId="cloudflare-disconnect-confirm"
  onConfirm={disconnect}
/>
