<script lang="ts">
  /**
   * Fleet settings: the VM providers this fleet is connected to.
   *
   * A new connection asks for its platform, address and credentials, and nothing else: the
   * sizes a new machine gets, the id range, the template, pool and storage start at the
   * platform's defaults (`GET /vm/provider-kinds`), folded under one summary line, and can be
   * opened and changed. A provider is saved only once its credentials reached it (the server
   * tests before it stores), so a typo is a refusal on this form rather than a power button that
   * fails later. The token secret is write-only: the form never shows it back, and leaving it
   * empty on edit keeps the stored one.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ServerCogIcon from "@lucide/svelte/icons/server-cog";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import * as Collapsible from "#lib/components/ui/collapsible/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import * as ToggleGroup from "#lib/components/ui/toggle-group/index.js";
  import ConfirmDialog from "#lib/dashboard/components/confirm-dialog.svelte";
  import InfoTip from "#lib/components/info-tip.svelte";
  import { fmt, formatDateTime, getI18n } from "#lib/i18n/index.js";
  import { vmApi } from "./api";
  import { useVmPower } from "./power-controller.svelte";
  import type { VmProviderInput, VmProviderKind, VmProviderView } from "./types";

  let { canManage }: { canManage: boolean } = $props();

  /** Platforms the form names so the choice is visible, but that have no driver yet. */
  const PLANNED = ["aws", "azure"] as const;
  /** The rows of the token-permission table, in the order a person sets them up. */
  const PERMISSIONS = ["pool", "template", "storage", "network", "linked"] as const;

  const i18n = getI18n();
  const power = useVmPower();
  /** Where a browser reaches this server: what an empty enrollment address falls back to, near enough. */
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  let providers = $state<VmProviderView[] | null>(null);
  let kinds = $state<VmProviderKind[]>([]);
  let testing = $state<string | null>(null);
  let removing = $state<VmProviderView | null>(null);
  let removeOpen = $state(false);
  let formOpen = $state(false);
  let editing = $state<VmProviderView | null>(null);
  let saving = $state(false);
  let defaultsOpen = $state(false);
  let advancedOpen = $state(false);
  let optionalOpen = $state(false);
  let permOpen = $state(false);

  // The form, as strings: inputs hold text, and the conversion happens once, on save.
  let platform = $state<"proxmox">("proxmox");
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
  let vmidMin = $state("");
  let vmidMax = $state("");
  let cores = $state("");
  let memoryGb = $state("");
  let diskGb = $state("");
  let fullClone = $state(false);
  let sleepTag = $state("");
  let backupStorage = $state("");
  let enrollUrl = $state("");

  onMount(() => {
    void load();
    vmApi.kinds().then((rows) => (kinds = rows)).catch(() => (kinds = []));
  });

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

  const gb = (mb: number): string => String(Math.round((mb / 1024) * 10) / 10);

  function openNew(): void {
    editing = null;
    platform = "proxmox";
    const defaults = kinds.find((entry) => entry.kind === platform)?.defaults;
    name = ""; baseUrl = ""; tokenId = ""; tokenSecret = ""; caCertificate = "";
    defaultNode = ""; templateNode = ""; templateVmid = ""; storage = ""; pool = "";
    // Empty when the defaults could not be read; then Save waits for them.
    vmidMin = defaults ? String(defaults.vmidMin) : "";
    vmidMax = defaults ? String(defaults.vmidMax) : "";
    cores = defaults ? String(defaults.cores) : "";
    memoryGb = defaults ? gb(defaults.memoryMb) : "";
    diskGb = defaults ? String(defaults.diskGb) : "";
    fullClone = defaults?.fullClone ?? false;
    sleepTag = ""; backupStorage = ""; enrollUrl = "";
    defaultsOpen = false;
    advancedOpen = false;
    optionalOpen = false;
    permOpen = false;
    formOpen = true;
  }

  function openEdit(provider: VmProviderView): void {
    editing = provider;
    platform = provider.kind;
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
    memoryGb = gb(provider.defaults.memoryMb);
    diskGb = provider.defaults.diskGb ? String(provider.defaults.diskGb) : "";
    fullClone = provider.defaults.fullClone;
    sleepTag = provider.sleepRequiresTag ?? "";
    backupStorage = provider.backupBeforeSleep ?? "";
    enrollUrl = provider.enrollUrl ?? "";
    defaultsOpen = false;
    advancedOpen = false;
    optionalOpen = false;
    permOpen = false;
    formOpen = true;
  }

  function input(): VmProviderInput {
    const blank = (value: string): string | null => (value.trim() === "" ? null : value.trim());
    return {
      kind: platform,
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
      defaultMemoryMb: Math.round(Number(memoryGb) * 1024),
      defaultDiskGb: diskGb.trim() ? Number(diskGb) : null,
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

  function summary(values: { cores: string | number; memory: string; disk: string | number | null; min: string | number; max: string | number }): string {
    return fmt(i18n.t.vm.settings.form.defaultsSummary, {
      cores: values.cores,
      memory: values.memory,
      disk: values.disk ?? "—",
      min: values.min,
      max: values.max,
    });
  }

  /** The name the server gives a connection left unnamed: the address's host. */
  const derivedName = $derived.by(() => {
    try {
      const host = new URL(baseUrl.trim()).hostname.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
      return host || "provider";
    } catch {
      return "provider";
    }
  });

  /** What the folded connection options hold, so they need not be opened to be checked. */
  const optionalSummary = $derived(
    fmt(i18n.t.vm.settings.form.optionalSummary, {
      name: name.trim() || derivedName,
      ca: caCertificate.trim()
        ? i18n.t.vm.settings.form.caNew
        : editing?.caFingerprint
          ? fmt(i18n.t.vm.settings.form.caStored, { fingerprint: `${editing.caFingerprint.slice(0, 11)}…` })
          : i18n.t.vm.settings.form.caSystem,
    }),
  );

  const whole = (value: string, min: number): boolean => /^\d+$/.test(value.trim()) && Number(value) >= min;
  const canSave = $derived(
    platform === "proxmox" && /^https:\/\/\S+$/.test(baseUrl.trim()) && tokenId.includes("!")
      && (editing !== null || tokenSecret.trim() !== "")
      && whole(vmidMin, 100) && whole(vmidMax, 100) && Number(vmidMin) <= Number(vmidMax)
      && whole(cores, 1) && Number(memoryGb) >= 0.5 && (diskGb.trim() === "" || whole(diskGb, 8))
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
              <Badge variant="secondary">{i18n.t.vm.settings.platform[provider.kind]}</Badge>
              <span class="text-muted-foreground text-xs font-normal">{fmt(i18n.t.vm.settings.machines, { count: provider.machineCount })}</span>
            </p>
            <p class="text-muted-foreground truncate text-xs">{provider.baseUrl} · {provider.tokenId}</p>
            <p class="text-muted-foreground text-xs" data-testid="vm-provider-defaults">
              {fmt(i18n.t.vm.settings.newMachines, {
                summary: summary({
                  cores: provider.defaults.cores,
                  memory: gb(provider.defaults.memoryMb),
                  disk: provider.defaults.diskGb,
                  min: provider.defaults.vmidMin,
                  max: provider.defaults.vmidMax,
                }),
              })}
            </p>
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
      <Dialog.Description>{i18n.t.vm.settings.form.required}</Dialog.Description>
    </Dialog.Header>
    <!-- Only what a connection cannot do without is open: the platform, the address and the
         token. Everything optional is folded, each fold saying in one line what it holds. -->
    <div class="-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
      <div class="grid gap-1.5">
        <Label>{i18n.t.vm.settings.platform.label}</Label>
        <!-- The planned platforms are listed but cannot be chosen: the choice is visible, and honest. -->
        <ToggleGroup.Root
          type="single"
          variant="outline"
          spacing={2}
          value={platform}
          onValueChange={(value: string) => { if (value === "proxmox") platform = value; }}
          disabled={editing !== null}
          class="flex flex-wrap justify-start"
          data-testid="vm-p-platform"
        >
          <ToggleGroup.Item value="proxmox" class="px-3" data-testid="vm-p-platform-proxmox">{i18n.t.vm.settings.platform.proxmox}</ToggleGroup.Item>
          {#each PLANNED as kind (kind)}
            <ToggleGroup.Item value={kind} disabled class="px-3" data-testid={`vm-p-platform-${kind}`}>
              {i18n.t.vm.settings.platform[kind]}
              <span class="text-muted-foreground text-xs">· {i18n.t.vm.settings.platform.soon}</span>
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      </div>

      <div class="grid gap-1.5">
        <Label for="vm-p-url">{i18n.t.vm.settings.form.baseUrl}</Label>
        <Input id="vm-p-url" bind:value={baseUrl} placeholder="https://pve.example.com:8006" data-testid="vm-p-url" />
        <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.baseUrlHint}</p>
      </div>
      <div class="grid items-start gap-3 sm:grid-cols-2">
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
      </div>

      <Collapsible.Root bind:open={permOpen} class="rounded-lg border p-3" data-testid="vm-p-perm">
        {@render fold(i18n.t.vm.settings.perm.title, null, permOpen, "vm-p-perm", i18n.t.vm.settings.form.show)}
        <Collapsible.Content class="pt-3">
          <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[minmax(0,12rem)_1fr]">
            {#each PERMISSIONS as row (row)}
              <dt class="font-medium">{i18n.t.vm.settings.perm[row]}</dt>
              <dd class="text-muted-foreground font-mono break-words">{i18n.t.vm.settings.perm[`${row}Privs`]}</dd>
            {/each}
          </dl>
          <p class="text-muted-foreground mt-3 text-xs">{i18n.t.vm.settings.perm.note}</p>
        </Collapsible.Content>
      </Collapsible.Root>

      <Collapsible.Root bind:open={optionalOpen} class="rounded-lg border p-3" data-testid="vm-p-optional">
        {@render fold(i18n.t.vm.settings.form.optional, optionalSummary, optionalOpen, "vm-p-optional", i18n.t.vm.settings.form.change)}
        <Collapsible.Content class="grid items-start gap-3 pt-3">
          <div class="grid gap-1.5">
            <Label for="vm-p-name">{i18n.t.vm.settings.form.name}</Label>
            <Input id="vm-p-name" bind:value={name} placeholder={derivedName} data-testid="vm-p-name" />
            <p class="text-muted-foreground text-xs">{fmt(i18n.t.vm.settings.form.nameHint, { name: derivedName })}</p>
          </div>
          <div class="grid gap-1.5">
            <Label for="vm-p-ca">{i18n.t.vm.settings.form.ca}</Label>
            <Textarea id="vm-p-ca" rows={3} class="font-mono text-xs" bind:value={caCertificate} placeholder="-----BEGIN CERTIFICATE-----" data-testid="vm-p-ca" />
            <p class="text-muted-foreground text-xs break-all">{editing?.caFingerprint ? `${i18n.t.vm.settings.form.fingerprint}: ${editing.caFingerprint}` : i18n.t.vm.settings.form.caHint}</p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      <Collapsible.Root bind:open={defaultsOpen} class="rounded-lg border p-3" data-testid="vm-p-defaults">
        {@render fold(
          i18n.t.vm.settings.form.defaultsTitle,
          summary({ cores: cores || "—", memory: memoryGb || "—", disk: diskGb || null, min: vmidMin || "—", max: vmidMax || "—" }),
          defaultsOpen,
          "vm-p-defaults",
          i18n.t.vm.settings.form.change,
        )}
        <p class="text-muted-foreground text-xs">{i18n.t.vm.settings.form.templateAuto}</p>
        <Collapsible.Content class="grid items-start gap-3 pt-3 sm:grid-cols-3">
          <div class="grid gap-1.5"><Label for="vm-p-cores">{i18n.t.vm.settings.form.cores}</Label><Input id="vm-p-cores" bind:value={cores} inputmode="numeric" data-testid="vm-p-cores" /></div>
          <div class="grid gap-1.5"><Label for="vm-p-memory">{i18n.t.vm.settings.form.memory}</Label><Input id="vm-p-memory" bind:value={memoryGb} inputmode="decimal" data-testid="vm-p-memory" /></div>
          <div class="grid gap-1.5">
            {@render tipped("vm-p-disk", i18n.t.vm.settings.form.disk, i18n.t.vm.settings.form.diskTip)}
            <Input id="vm-p-disk" bind:value={diskGb} inputmode="numeric" data-testid="vm-p-disk" />
          </div>
          <div class="grid gap-1.5 sm:col-span-2">
            {@render tipped("vm-p-template-node", i18n.t.vm.settings.form.template, i18n.t.vm.settings.form.templateTip)}
            <div class="flex gap-2">
              <Input id="vm-p-template-node" bind:value={templateNode} placeholder={i18n.t.vm.settings.form.node} />
              <Input bind:value={templateVmid} inputmode="numeric" placeholder="9001" aria-label={i18n.t.vm.settings.form.template} />
            </div>
          </div>
          <div class="grid gap-1.5">
            {@render tipped("vm-p-vmid-min", i18n.t.vm.settings.form.vmidRange, i18n.t.vm.settings.form.vmidRangeTip)}
            <div class="flex gap-2"><Input id="vm-p-vmid-min" bind:value={vmidMin} inputmode="numeric" data-testid="vm-p-vmid-min" /><Input bind:value={vmidMax} inputmode="numeric" aria-label={i18n.t.vm.settings.form.vmidRange} data-testid="vm-p-vmid-max" /></div>
          </div>
          <div class="flex items-center gap-2 text-sm sm:col-span-3">
            <label class="flex items-center gap-2"><Checkbox bind:checked={fullClone} data-testid="vm-p-full-clone" />{i18n.t.vm.settings.form.fullClone}</label>
            <InfoTip text={i18n.t.vm.settings.form.fullCloneTip} testId="vm-p-full-clone-tip" />
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      <Collapsible.Root bind:open={advancedOpen} class="rounded-lg border p-3" data-testid="vm-p-advanced">
        {@render fold(i18n.t.vm.settings.form.advanced, null, advancedOpen, "vm-p-advanced", i18n.t.vm.settings.form.change)}
        <Collapsible.Content class="grid items-start gap-3 pt-3 sm:grid-cols-3">
          <div class="grid gap-1.5">
            {@render tipped("vm-p-node", i18n.t.vm.settings.form.node, i18n.t.vm.settings.form.nodeTip)}
            <Input id="vm-p-node" bind:value={defaultNode} placeholder={i18n.t.vm.settings.form.nodeAuto} />
          </div>
          <div class="grid gap-1.5">
            {@render tipped("vm-p-storage", i18n.t.vm.settings.form.storage, i18n.t.vm.settings.form.storageTip)}
            <Input id="vm-p-storage" bind:value={storage} placeholder={i18n.t.vm.settings.form.storageAuto} />
          </div>
          <div class="grid gap-1.5">
            {@render tipped("vm-p-pool", i18n.t.vm.settings.form.pool, i18n.t.vm.settings.form.poolTip)}
            <Input id="vm-p-pool" bind:value={pool} placeholder={i18n.t.vm.settings.form.poolAuto} />
          </div>
          <div class="grid gap-1.5 sm:col-span-3 sm:grid-cols-2 sm:gap-3">
            <div class="grid gap-1.5">
              {@render tipped("vm-p-sleep-tag", i18n.t.vm.settings.form.sleepTag, i18n.t.vm.settings.form.sleepTagTip)}
              <Input id="vm-p-sleep-tag" bind:value={sleepTag} placeholder="on-demand" data-testid="vm-p-sleep-tag" />
            </div>
            <div class="grid gap-1.5">
              {@render tipped("vm-p-backup", i18n.t.vm.settings.form.backup, i18n.t.vm.settings.form.backupTip)}
              <Input id="vm-p-backup" bind:value={backupStorage} placeholder="backups" />
            </div>
          </div>
          <div class="grid gap-1.5 sm:col-span-3">
            {@render tipped("vm-p-enroll-url", i18n.t.vm.settings.form.enrollUrl, i18n.t.vm.settings.form.enrollUrlTip)}
            <Input id="vm-p-enroll-url" bind:value={enrollUrl} placeholder={origin} data-testid="vm-p-enroll-url" />
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (formOpen = false)}>{i18n.t.vm.settings.form.cancel}</Button>
      <Button disabled={!canSave || saving} onclick={save} data-testid="vm-p-save">{i18n.t.vm.settings.form.save}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- A folded section's first row: what it is, what it holds now, and the control that opens it. -->
{#snippet fold(title: string, detail: string | null, isOpen: boolean, testId: string, action: string)}
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p class="text-sm font-medium">{title}</p>
      {#if detail}<p class="text-muted-foreground text-xs break-all" data-testid={`${testId}-summary`}>{detail}</p>{/if}
    </div>
    <Collapsible.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="sm" class="shrink-0 gap-1" data-testid={`${testId}-toggle`}>
          {action}
          <ChevronDownIcon class="size-4 {isOpen ? 'rotate-180' : ''}" />
        </Button>
      {/snippet}
    </Collapsible.Trigger>
  </div>
{/snippet}

<!-- A label with its explanation one hover or tap away, instead of a paragraph under the field. -->
{#snippet tipped(id: string, label: string, tip: string)}
  <div class="flex items-center gap-1">
    <Label for={id}>{label}</Label>
    <InfoTip text={tip} testId={`${id}-tip`} />
  </div>
{/snippet}

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
