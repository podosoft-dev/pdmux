<script lang="ts">
  /**
   * The host page's "Virtual machine" card: what the machine is, what it is doing, the same
   * power changes the pane offers, and — for a fleet administrator — linking or unlinking it.
   *
   * The power buttons go through the shell's one controller and confirmation, so a change
   * started here shows in every pane of the machine at once, like one started from a pane.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import ConfirmDialog from "#lib/dashboard/components/confirm-dialog.svelte";
  import type { HostView } from "#lib/dashboard/types.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { vmApi } from "./api";
  import { elapsedSeconds, powerItems } from "./power";
  import { useVmPower } from "./power-controller.svelte";
  import type { VmCatalog, VmProviderView } from "./types";
  import VmDeleteDialog from "./vm-delete-dialog.svelte";

  let {
    host,
    canManage,
    now,
    onChanged,
    onDeleted,
  }: {
    host: HostView;
    canManage: boolean;
    now: number;
    /** Ask the shell to read the fleet again after a link change. */
    onChanged: () => Promise<void>;
    /** Where to go once a delete is accepted: the host is about to disappear from under this page. */
    onDeleted?: () => Promise<void>;
  } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  const vm = $derived(host.vm);
  const items = $derived(vm ? powerItems(vm, canManage) : []);
  const sending = $derived(Boolean(power?.sending[host.id]));

  let providers = $state<VmProviderView[] | null>(null);
  let providerId = $state("");
  let catalog = $state<VmCatalog | null>(null);
  let node = $state("");
  let vmid = $state("");
  let linking = $state(false);
  let unlinkOpen = $state(false);
  let deleteOpen = $state(false);
  let reenrolling = $state(false);

  async function reenroll(): Promise<void> {
    reenrolling = true;
    try {
      const view = await vmApi.reenroll(host.id);
      toast.success(fmt(i18n.t.vm.reenroll.accepted, { name: view.name }));
      await onChanged();
    } catch (error) {
      toast.error(power?.describe(error) ?? String(error));
    } finally {
      reenrolling = false;
    }
  }

  onMount(() => {
    if (!canManage || vm) return;
    void vmApi.providers().then((rows) => {
      providers = rows;
      if (rows.length === 1 && rows[0]) void chooseProvider(rows[0].id);
    }).catch(() => (providers = []));
  });

  async function chooseProvider(id: string): Promise<void> {
    providerId = id;
    catalog = null;
    node = "";
    try {
      catalog = await vmApi.catalog(id);
      const online = catalog.nodes.filter((entry) => entry.online);
      if (online.length === 1 && online[0]) node = online[0].name;
    } catch (error) {
      toast.error(power?.describe(error) ?? String(error));
    }
  }

  async function link(): Promise<void> {
    const id = Number(vmid);
    if (!providerId || !node || !Number.isInteger(id)) return;
    linking = true;
    try {
      const linked = await vmApi.link(host.id, { providerId, node, vmid: id });
      toast.success(fmt(i18n.t.vm.section.linked, { name: linked.name }));
      await onChanged();
    } catch (error) {
      toast.error(power?.describe(error) ?? String(error));
    } finally {
      linking = false;
    }
  }

  async function unlink(): Promise<void> {
    try {
      const result = await vmApi.unlink(host.id);
      toast.success(fmt(i18n.t.vm.section.unlinked, { name: result.name }));
      await onChanged();
    } catch (error) {
      toast.error(power?.describe(error) ?? String(error));
    }
  }

  const progress = $derived(vm?.operation
    ? fmt(i18n.t.vm.progress, {
        operation: i18n.t.vm.operation[vm.operation.action],
        name: vm.operation.requestedBy.name ?? i18n.t.vm.someone,
        seconds: elapsedSeconds(vm, now),
      })
    : null);
</script>

<!-- Only a host with a machine, or an administrator with a provider to link from: a fleet that
     does not use VMs sees no card at all. -->
{#if vm || (canManage && providers && providers.length > 0)}
  <Card.Root class="shrink-0" data-testid="host-vm">
    <Card.Header>
      <Card.Title>{i18n.t.vm.section.title}</Card.Title>
      <Card.Description>{vm ? i18n.t.vm.section.description : i18n.t.vm.section.linkHint}</Card.Description>
      {#if vm}
        <Card.Action>
          <Badge variant={vm.state === "running" ? "default" : "secondary"} data-testid="host-vm-state">{i18n.t.vm.state[vm.state]}</Badge>
        </Card.Action>
      {/if}
    </Card.Header>
    <Card.Content class="flex flex-col gap-3">
      {#if vm}
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-muted-foreground">{i18n.t.vm.section.provider}</dt>
          <dd>{vm.provider.name} · {vm.origin === "created" ? i18n.t.vm.section.created : i18n.t.vm.section.linkedOrigin}</dd>
          <dt class="text-muted-foreground">{i18n.t.vm.section.location}</dt>
          <dd>{vm.location}</dd>
          <dt class="text-muted-foreground">{i18n.t.vm.section.vmid}</dt>
          <dd>{vm.name} ({vm.externalId})</dd>
        </dl>
        {#if progress}
          <p class="text-muted-foreground text-sm" data-testid="host-vm-progress">{progress}</p>
        {:else if vm.error}
          <p class="text-destructive text-sm" data-testid="host-vm-error">{power?.describe(null, vm.error.code) ?? vm.error.code}</p>
        {/if}
        {#if items.length > 0}
          <div class="flex flex-wrap gap-2" data-testid="host-vm-actions">
            {#each items as item (item.action)}
              <Button
                size="sm"
                variant={item.kind === "primary" ? "default" : item.kind === "danger" ? "destructive" : "outline"}
                disabled={sending}
                title={i18n.t.vm.hint[item.label]}
                data-pdmux-vm-action={item.action}
                onclick={() => power?.choose(host, item)}
              >
                {i18n.t.vm.action[item.label]}
              </Button>
            {/each}
          </div>
        {/if}
        {#if canManage && vm.origin === "linked"}
          <div>
            <Button size="sm" variant="ghost" disabled={Boolean(vm.operation)} data-testid="host-vm-unlink" onclick={() => (unlinkOpen = true)}>
              {i18n.t.vm.section.unlink}
            </Button>
          </div>
        {:else if canManage && (vm.available.enroll || vm.available.delete)}
          <!-- A machine pdmux created: it can be given a new code, or deleted with its disks. -->
          <div class="flex flex-wrap gap-2 border-t pt-3">
            {#if vm.available.enroll}
              <Button size="sm" variant="outline" disabled={reenrolling} title={i18n.t.vm.reenroll.hint} data-testid="host-vm-reenroll" onclick={reenroll}>
                {i18n.t.vm.reenroll.action}
              </Button>
            {/if}
            {#if vm.available.delete}
              <Button size="sm" variant="ghost" class="text-destructive" data-testid="host-vm-delete" onclick={() => (deleteOpen = true)}>
                {i18n.t.vm.remove.action}
              </Button>
            {/if}
          </div>
        {/if}
      {:else if providers}
        <div class="grid gap-3 sm:grid-cols-3" data-testid="host-vm-link">
          <div class="flex flex-col gap-1.5">
            <Label for="vm-link-provider">{i18n.t.vm.section.provider}</Label>
            <Select.Root type="single" value={providerId} onValueChange={(value: string) => void chooseProvider(value)}>
              <Select.Trigger id="vm-link-provider" data-testid="host-vm-provider">
                {providers.find((entry) => entry.id === providerId)?.name ?? i18n.t.vm.section.chooseProvider}
              </Select.Trigger>
              <Select.Content>
                {#each providers as provider (provider.id)}
                  <Select.Item value={provider.id}>{provider.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="vm-link-node">{i18n.t.vm.section.location}</Label>
            <Select.Root type="single" bind:value={node} disabled={!catalog}>
              <Select.Trigger id="vm-link-node" data-testid="host-vm-node">{node || i18n.t.vm.section.chooseNode}</Select.Trigger>
              <Select.Content>
                {#each catalog?.nodes ?? [] as entry (entry.name)}
                  <Select.Item value={entry.name} disabled={!entry.online}>{entry.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="vm-link-vmid">{i18n.t.vm.section.vmid}</Label>
            <Input id="vm-link-vmid" inputmode="numeric" bind:value={vmid} placeholder="500" data-testid="host-vm-vmid" />
          </div>
        </div>
        <div>
          <Button size="sm" disabled={linking || !providerId || !node || !/^\d+$/.test(vmid)} data-testid="host-vm-link-submit" onclick={link}>
            {i18n.t.vm.section.linkSubmit}
          </Button>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  {#if vm}
    <ConfirmDialog
      bind:open={unlinkOpen}
      title={fmt(i18n.t.vm.section.unlinkTitle, { name: vm.name })}
      warning={i18n.t.vm.section.unlinkBody}
      confirmLabel={i18n.t.vm.section.unlink}
      testId="host-vm-unlink-confirm"
      onConfirm={unlink}
    />
    <VmDeleteDialog bind:open={deleteOpen} {host} onDone={onDeleted ?? onChanged} />
  {/if}
{/if}
