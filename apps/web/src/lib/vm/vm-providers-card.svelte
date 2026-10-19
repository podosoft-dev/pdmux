<script lang="ts">
  /**
   * Fleet settings: the VM providers this fleet is connected to.
   *
   * A provider is saved only once its credentials reached it (the server tests before it
   * stores), so a typo is a refusal on this form rather than a power button that fails later.
   * The token secret is write-only: the form never shows it back, and leaving it empty on
   * edit keeps the stored one.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import ServerCogIcon from "@lucide/svelte/icons/server-cog";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import ConfirmDialog from "#lib/dashboard/components/confirm-dialog.svelte";
  import { fmt, formatDateTime, getI18n } from "#lib/i18n/index.js";
  import { vmApi } from "./api";
  import { useVmPower } from "./power-controller.svelte";
  import type { VmProviderInput, VmProviderView } from "./types";

  let { canManage }: { canManage: boolean } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  /** Where a browser reaches this server: what an empty enrollment address falls back to, near enough. */
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  let providers = $state<VmProviderView[] | null>(null);
  let testing = $state<string | null>(null);
  let removing = $state<VmProviderView | null>(null);
  let removeOpen = $state(false);
  let formOpen = $state(false);
  let editing = $state<VmProviderView | null>(null);
  let saving = $state(false);

  // The form, as strings: inputs hold text, and the conversion happens once, on save.
  let name = $state("");
  let baseUrl = $state("");
  let tokenId = $state("");
  let tokenSecret = $state("");
  let caCertificate = $state("");
  let defaultNode = $state("");
  let templateNode = $state("");
  let templateVmid = $state("");
  let storage = $state("");
  let pool = $state("");
  let vmidMin = $state("500");
  let vmidMax = $state("519");
  let cores = $state("2");
  let memoryMb = $state("4096");
  let fullClone = $state(false);
  let sleepTag = $state("");
  let backupStorage = $state("");
  let enrollUrl = $state("");

  onMount(() => void load());

  async function load(): Promise<void> {
    try {
      providers = await vmApi.providers();
    } catch {
      // A server without the VM module (a desktop runtime) has nothing to show.
      providers = [];
    }
  }

  function describe(error: unknown): string {
    return power?.describe(error) ?? String(error);
  }

  function openNew(): void {
    editing = null;
    name = ""; baseUrl = ""; tokenId = ""; tokenSecret = ""; caCertificate = "";
    defaultNode = ""; templateNode = ""; templateVmid = ""; storage = ""; pool = "";
    vmidMin = "500"; vmidMax = "519"; cores = "2"; memoryMb = "4096"; fullClone = false;
    sleepTag = ""; backupStorage = ""; enrollUrl = "";
    formOpen = true;
  }

  function openEdit(provider: VmProviderView): void {
    editing = provider;
    name = provider.name;
    baseUrl = provider.baseUrl;
    tokenId = provider.tokenId;
    tokenSecret = "";
    // The CA is not sent back; an empty field on edit means "keep it".
    caCertificate = "";
    defaultNode = provider.defaults.node ?? "";
    templateNode = provider.defaults.template?.node ?? "";
    templateVmid = provider.defaults.template ? String(provider.defaults.template.vmid) : "";
    storage = provider.defaults.storage ?? "";
    pool = provider.defaults.pool ?? "";
    vmidMin = String(provider.defaults.vmidMin);
    vmidMax = String(provider.defaults.vmidMax);
    cores = String(provider.defaults.cores);
    memoryMb = String(provider.defaults.memoryMb);
    fullClone = provider.defaults.fullClone;
    sleepTag = provider.sleepRequiresTag ?? "";
    backupStorage = provider.backupBeforeSleep ?? "";
    enrollUrl = provider.enrollUrl ?? "";
    formOpen = true;
  }

  function input(): VmProviderInput {
    const blank = (value: string): string | null => (value.trim() === "" ? null : value.trim());
    return {
      kind: "proxmox",
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      tokenId: tokenId.trim(),
      tokenSecret: tokenSecret.trim(),
      caCertificate: blank(caCertificate),
      defaultNode: blank(defaultNode),
      defaultTemplateNode: blank(templateNode),
      defaultTemplateVmid: templateVmid.trim() ? Number(templateVmid) : null,
      defaultStorage: blank(storage),
      defaultPool: blank(pool),
      vmidMin: Number(vmidMin),
      vmidMax: Number(vmidMax),
      defaultCores: Number(cores),
      defaultMemoryMb: Number(memoryMb),
      fullClone,
      sleepRequiresTag: blank(sleepTag),
      backupBeforeSleep: blank(backupStorage),
      enrollUrl: blank(enrollUrl),
    };
  }

  async function save(): Promise<void> {
    saving = true;
    try {
      const value = input();
      let saved: VmProviderView;
      if (editing) {
        const { tokenSecret: secret, caCertificate: ca, kind: _kind, ...rest } = value;
        saved = await vmApi.updateProvider(editing.id, {
          ...rest,
          ...(secret ? { tokenSecret: secret } : {}),
          ...(ca ? { caCertificate: ca } : {}),
        });
      } else {
        saved = await vmApi.createProvider(value);
      }
      toast.success(fmt(i18n.t.vm.settings.saved, { name: saved.name }));
      formOpen = false;
      await load();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      saving = false;
    }
  }

  async function test(provider: VmProviderView): Promise<void> {
    testing = provider.id;
    try {
      const result = await vmApi.testProvider(provider.id);
      if (result.lastErrorCode) toast.error(power?.describe(null, result.lastErrorCode) ?? result.lastErrorCode);
      else toast.success(fmt(i18n.t.vm.settings.tested, { name: provider.name }));
      await load();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      testing = null;
    }
  }

  async function remove(): Promise<void> {
    const provider = removing;
    if (!provider) return;
    try {
      await vmApi.removeProvider(provider.id);
      toast.success(fmt(i18n.t.vm.settings.removed, { name: provider.name }));
      await load();
    } catch (error) {
      toast.error(describe(error));
    }
  }

  function status(provider: VmProviderView): string {
    if (!provider.lastTestedAt) return i18n.t.vm.settings.neverTested;
    const when = formatDateTime(provider.lastTestedAt);
    return provider.lastErrorCode
      ? fmt(i18n.t.vm.settings.lastError, { when, error: power?.describe(null, provider.lastErrorCode) ?? provider.lastErrorCode })
      : fmt(i18n.t.vm.settings.lastOk, { when });
  }

  const canSave = $derived(
    name.trim() !== "" && /^https:\/\//.test(baseUrl.trim()) && tokenId.includes("!")
      && (editing !== null || tokenSecret.trim() !== "")
      && Number.isInteger(Number(vmidMin)) && Number.isInteger(Number(vmidMax)) && Number(vmidMin) <= Number(vmidMax)
      && (enrollUrl.trim() === "" || /^https?:\/\/\S+$/.test(enrollUrl.trim())),
  );
</script>

{#if providers && (providers.length > 0 || canManage)}
  <Card.Root class="shrink-0" data-testid="vm-providers">
    <Card.Header>
      <Card.Title class="flex items-center gap-2"><ServerCogIcon class="size-4" aria-hidden="true" />{i18n.t.vm.settings.title}</Card.Title>
      <Card.Description>{i18n.t.vm.settings.description}</Card.Description>
      {#if canManage}
        <Card.Action>
          <Button size="sm" onclick={openNew} data-testid="vm-provider-add">{i18n.t.vm.settings.add}</Button>
        </Card.Action>
      {/if}
    </Card.Header>
    <Card.Content class="flex flex-col gap-3">
      {#if providers.length === 0}
        <p class="text-muted-foreground text-sm">{i18n.t.vm.settings.empty}</p>
      {/if}
      {#each providers as provider (provider.id)}
        <div class="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between" data-testid="vm-provider-row" data-provider={provider.name}>
          <div class="flex min-w-0 flex-col gap-1 text-sm">
            <p class="flex flex-wrap items-center gap-2 font-medium">
              {provider.name}
              <Badge variant="secondary">Proxmox VE</Badge>
              <span class="text-muted-foreground text-xs font-normal">{fmt(i18n.t.vm.settings.machines, { count: provider.machineCount })}</span>
            </p>
            <p class="text-muted-foreground truncate text-xs">{provider.baseUrl} · {provider.tokenId}</p>
            {#if provider.caFingerprint}
              <p class="text-muted-foreground truncate font-mono text-xs" title={provider.caFingerprint}>{i18n.t.vm.settings.form.fingerprint}: {provider.caFingerprint}</p>
            {/if}
            <p class={`text-xs ${provider.lastErrorCode ? "text-destructive" : "text-muted-foreground"}`} data-testid="vm-provider-status">{status(provider)}</p>
          </div>
          {#if canManage}
            <div class="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" disabled={testing === provider.id} onclick={() => test(provider)} data-testid="vm-provider-test">
                {testing === provider.id ? i18n.t.vm.settings.testing : i18n.t.vm.settings.test}
              </Button>
              <Button size="sm" variant="outline" onclick={() => openEdit(provider)} data-testid="vm-provider-edit">{i18n.t.vm.settings.edit}</Button>
              <Button
                size="sm"
                variant="ghost"
                class="text-destructive"
                disabled={provider.machineCount > 0}
                title={provider.machineCount > 0 ? fmt(i18n.t.vm.settings.inUse, { count: provider.machineCount }) : undefined}
                onclick={() => { removing = provider; removeOpen = true; }}
                data-testid="vm-provider-remove"
              >{i18n.t.vm.settings.remove}</Button>
            </div>
          {/if}
        </div>
      {/each}
    </Card.Content>
  </Card.Root>
{/if}

<Dialog.Root bind:open={formOpen}>
  <!-- The fields scroll between a fixed header and footer: on a short screen Save stays in view. -->
  <Dialog.Content class="flex max-h-[90dvh] flex-col sm:max-w-2xl" data-testid="vm-provider-form">
    <Dialog.Header>
      <Dialog.Title>{editing ? fmt(i18n.t.vm.settings.form.titleEdit, { name: editing.name }) : i18n.t.vm.settings.form.titleNew}</Dialog.Title>
      <Dialog.Description>{i18n.t.vm.settings.form.permissions}</Dialog.Description>
    </Dialog.Header>
    <div class="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
      <div class="grid items-start gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="vm-p-name">{i18n.t.vm.settings.form.name}</Label>
          <Input id="vm-p-name" bind:value={name} placeholder="lab" data-testid="vm-p-name" />
          <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.nameHint}</p>
        </div>
        <div class="grid gap-1.5">
          <Label for="vm-p-url">{i18n.t.vm.settings.form.baseUrl}</Label>
          <Input id="vm-p-url" bind:value={baseUrl} placeholder="https://pve.example.com:8006" data-testid="vm-p-url" />
          <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.baseUrlHint}</p>
        </div>
        <div class="grid gap-1.5">
          <Label for="vm-p-token-id">{i18n.t.vm.settings.form.tokenId}</Label>
          <Input id="vm-p-token-id" bind:value={tokenId} placeholder="pdmux@pve!vm-provider" autocomplete="off" data-testid="vm-p-token-id" />
          <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.tokenIdHint}</p>
        </div>
        <div class="grid gap-1.5">
          <Label for="vm-p-token-secret">{i18n.t.vm.settings.form.tokenSecret}</Label>
          <Input id="vm-p-token-secret" type="password" bind:value={tokenSecret} autocomplete="off" data-testid="vm-p-token-secret" />
          {#if editing}<p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.tokenSecretKeep}</p>{/if}
        </div>
        <div class="grid gap-1.5 sm:col-span-2">
          <Label for="vm-p-ca">{i18n.t.vm.settings.form.ca}</Label>
          <Textarea id="vm-p-ca" rows={4} class="font-mono text-xs" bind:value={caCertificate} placeholder="-----BEGIN CERTIFICATE-----" data-testid="vm-p-ca" />
          <p class="text-muted-foreground text-xs break-all">{editing?.caFingerprint ? `${i18n.t.vm.settings.form.fingerprint}: ${editing.caFingerprint}` : i18n.t.vm.settings.form.caHint}</p>
        </div>
      </div>
      <p class="text-sm font-medium">{i18n.t.vm.settings.form.defaults}</p>
      <div class="grid items-start gap-3 sm:grid-cols-3">
        <div class="grid gap-1.5"><Label for="vm-p-node">{i18n.t.vm.settings.form.node}</Label><Input id="vm-p-node" bind:value={defaultNode} /></div>
        <div class="grid gap-1.5">
          <Label for="vm-p-template-node">{i18n.t.vm.settings.form.template}</Label>
          <div class="flex gap-2"><Input id="vm-p-template-node" bind:value={templateNode} placeholder="node" /><Input bind:value={templateVmid} inputmode="numeric" placeholder="9001" aria-label={i18n.t.vm.settings.form.template} /></div>
        </div>
        <div class="grid gap-1.5"><Label for="vm-p-storage">{i18n.t.vm.settings.form.storage}</Label><Input id="vm-p-storage" bind:value={storage} /></div>
        <div class="grid gap-1.5"><Label for="vm-p-pool">{i18n.t.vm.settings.form.pool}</Label><Input id="vm-p-pool" bind:value={pool} /></div>
        <div class="grid gap-1.5">
          <Label for="vm-p-vmid-min">{i18n.t.vm.settings.form.vmidRange}</Label>
          <div class="flex gap-2"><Input id="vm-p-vmid-min" bind:value={vmidMin} inputmode="numeric" data-testid="vm-p-vmid-min" /><Input bind:value={vmidMax} inputmode="numeric" aria-label={i18n.t.vm.settings.form.vmidRange} data-testid="vm-p-vmid-max" /></div>
        </div>
        <div class="grid gap-1.5">
          <Label for="vm-p-cores">{i18n.t.vm.settings.form.cores} / {i18n.t.vm.settings.form.memory}</Label>
          <div class="flex gap-2"><Input id="vm-p-cores" bind:value={cores} inputmode="numeric" /><Input bind:value={memoryMb} inputmode="numeric" aria-label={i18n.t.vm.settings.form.memory} /></div>
        </div>
        <label class="flex items-center gap-2 text-sm sm:col-span-3"><Checkbox bind:checked={fullClone} />{i18n.t.vm.settings.form.fullClone}</label>
        <div class="grid gap-1.5 sm:col-span-3 sm:grid-cols-2 sm:gap-3">
          <div class="grid gap-1.5">
            <Label for="vm-p-sleep-tag">{i18n.t.vm.settings.form.sleepTag}</Label>
            <Input id="vm-p-sleep-tag" bind:value={sleepTag} placeholder="on-demand" data-testid="vm-p-sleep-tag" />
            <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.sleepTagHint}</p>
          </div>
          <div class="grid gap-1.5">
            <Label for="vm-p-backup">{i18n.t.vm.settings.form.backup}</Label>
            <Input id="vm-p-backup" bind:value={backupStorage} placeholder="backups" />
            <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.backupHint}</p>
          </div>
        </div>
        <div class="grid gap-1.5 sm:col-span-3">
          <Label for="vm-p-enroll-url">{i18n.t.vm.settings.form.enrollUrl}</Label>
          <Input id="vm-p-enroll-url" bind:value={enrollUrl} placeholder={origin} data-testid="vm-p-enroll-url" />
          <p class="text-muted-foreground text-xs break-all">{fmt(i18n.t.vm.settings.form.enrollUrlHint, { url: origin })}</p>
        </div>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (formOpen = false)}>{i18n.t.vm.settings.form.cancel}</Button>
      <Button disabled={!canSave || saving} onclick={save} data-testid="vm-p-save">{i18n.t.vm.settings.form.save}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

{#if removing}
  <ConfirmDialog
    bind:open={removeOpen}
    title={fmt(i18n.t.vm.settings.removeTitle, { name: removing.name })}
    warning={i18n.t.vm.settings.removeBody}
    confirmLabel={i18n.t.vm.settings.remove}
    testId="vm-provider-remove-confirm"
    onConfirm={remove}
  />
{/if}
