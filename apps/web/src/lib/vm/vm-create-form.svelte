<script lang="ts">
  /**
   * "Add host" → "Create a VM": a new machine from a provider's template, which becomes the host.
   *
   * Nothing to paste afterwards. The server hands the machine its registration code through the
   * machine's firmware and the template enrolls on first boot, so the new host appears on every
   * screen as "creating" at once and turns into a normal host when its agent connects.
   *
   * ⚠ ONE KEY PER OPENING OF THE DIALOG. A double click, or a retry after a dropped response, sends
   * the same key, and the server answers with the machine the first request made.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { ApiError } from "@podosoft/podokit-api-client";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { causeMessage } from "#lib/dashboard/wording.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { vmApi } from "./api";
  import { useVmPower } from "./power-controller.svelte";
  import type { CreatedVm, VmCatalog, VmProviderView } from "./types";

  let {
    providers,
    onCreated,
    onCancel,
  }: {
    providers: VmProviderView[];
    onCreated: (created: CreatedVm) => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  const idempotencyKey = crypto.randomUUID();

  let label = $state("");
  let providerId = $state("");
  let catalog = $state<VmCatalog | null>(null);
  /** `node/vmid`, or `DEFAULT` for the provider's default. */
  const DEFAULT = "default";
  let template = $state(DEFAULT);
  let cores = $state("");
  let memoryMb = $state("");
  let saving = $state(false);

  const provider = $derived(providers.find((entry) => entry.id === providerId) ?? null);
  const fallback = $derived(provider?.defaults.template ?? null);
  const templates = $derived(catalog?.templates ?? []);
  const fallbackName = $derived(
    fallback ? (templates.find((entry) => entry.ref.node === fallback.node && entry.ref.vmid === fallback.vmid)?.name ?? `${fallback.node}/${fallback.vmid}`) : "",
  );

  onMount(() => {
    if (providers[0]) void choose(providers[0].id);
  });

  async function choose(id: string): Promise<void> {
    providerId = id;
    template = DEFAULT;
    catalog = null;
    const chosen = providers.find((entry) => entry.id === id);
    cores = chosen ? String(chosen.defaults.cores) : "";
    memoryMb = chosen ? String(chosen.defaults.memoryMb) : "";
    try {
      catalog = await vmApi.catalog(id);
    } catch (error) {
      toast.error(describe(error));
    }
  }

  function describe(error: unknown): string {
    return error instanceof ApiError && error.code.startsWith("VM_") && power ? power.describe(error) : causeMessage(error, i18n.t);
  }

  const canSave = $derived(
    label.trim() !== "" && provider !== null && (template !== DEFAULT || fallback !== null)
      && /^\d+$/.test(cores) && /^\d+$/.test(memoryMb),
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSave || !provider) return;
    saving = true;
    const [node, vmid] = template !== DEFAULT ? template.split("/") : [null, null];
    try {
      const created = await vmApi.create({
        providerId: provider.id,
        label: label.trim(),
        templateNode: node ?? null,
        templateVmid: vmid ? Number(vmid) : null,
        cores: Number(cores),
        memoryMb: Number(memoryMb),
        idempotencyKey,
      });
      toast.success(fmt(i18n.t.vm.create.accepted, { name: created.vm.name }));
      await onCreated(created);
    } catch (error) {
      toast.error(describe(error));
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={submit} class="flex flex-col gap-3" data-testid="vm-create">
  <p class="text-muted-foreground text-sm">{i18n.t.vm.create.hint}</p>
  <div class="flex flex-col gap-1.5">
    <Label for="vm-create-label">{i18n.t.dash.hosts.label}</Label>
    <Input id="vm-create-label" bind:value={label} required data-testid="vm-create-label" />
  </div>
  {#if providers.length > 1}
    <div class="flex flex-col gap-1.5">
      <Label for="vm-create-provider">{i18n.t.vm.create.provider}</Label>
      <Select.Root type="single" value={providerId} onValueChange={(value: string) => void choose(value)}>
        <Select.Trigger id="vm-create-provider" data-testid="vm-create-provider">{provider?.name ?? ""}</Select.Trigger>
        <Select.Content>
          {#each providers as entry (entry.id)}
            <Select.Item value={entry.id}>{entry.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}
  <div class="flex flex-col gap-1.5">
    <Label for="vm-create-template">{i18n.t.vm.create.template}</Label>
    {#if fallback || templates.length > 0}
      <Select.Root type="single" bind:value={template}>
        <Select.Trigger id="vm-create-template" data-testid="vm-create-template">
          {template !== DEFAULT ? (templates.find((entry) => `${entry.ref.node}/${entry.ref.vmid}` === template)?.name ?? template) : fallback ? fmt(i18n.t.vm.create.templateDefault, { name: fallbackName }) : i18n.t.vm.create.template}
        </Select.Trigger>
        <Select.Content>
          {#if fallback}
            <Select.Item value={DEFAULT}>{fmt(i18n.t.vm.create.templateDefault, { name: fallbackName })}</Select.Item>
          {/if}
          {#each templates as entry (`${entry.ref.node}/${entry.ref.vmid}`)}
            <Select.Item value={`${entry.ref.node}/${entry.ref.vmid}`}>{entry.name} · {entry.ref.node}/{entry.ref.vmid}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {:else if catalog}
      <p class="text-destructive text-sm" data-testid="vm-create-no-template">{i18n.t.vm.create.noTemplate}</p>
    {/if}
  </div>
  <div class="grid grid-cols-2 gap-3">
    <div class="flex flex-col gap-1.5">
      <Label for="vm-create-cores">{i18n.t.vm.create.cores}</Label>
      <Input id="vm-create-cores" inputmode="numeric" bind:value={cores} data-testid="vm-create-cores" />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="vm-create-memory">{i18n.t.vm.create.memory}</Label>
      <Input id="vm-create-memory" inputmode="numeric" bind:value={memoryMb} data-testid="vm-create-memory" />
    </div>
  </div>
  <Dialog.Footer>
    <Button type="button" variant="outline" onclick={onCancel}>{i18n.t.dash.form.cancel}</Button>
    <Button type="submit" disabled={!canSave || saving} data-testid="vm-create-submit">{i18n.t.vm.create.submit}</Button>
  </Dialog.Footer>
</form>
