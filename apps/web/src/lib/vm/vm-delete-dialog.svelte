<script lang="ts">
  /**
   * Delete a machine pdmux created: its disks go, then the host and its sessions.
   *
   * The name is typed again, and the server compares it too — a dialog that only asks "are you
   * sure?" is one Enter key away from destroying a disk.
   */
  import { toast } from "svelte-sonner";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { vmApi } from "./api";
  import { useVmPower } from "./power-controller.svelte";

  let {
    open = $bindable(false),
    host,
    onDone,
  }: {
    open?: boolean;
    host: HostView;
    onDone: () => Promise<void>;
  } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  let typed = $state("");
  let sending = $state(false);
  const name = $derived(host.vm?.name ?? "");

  $effect(() => {
    if (open) typed = "";
  });

  async function confirm(): Promise<void> {
    if (typed.trim() !== name) return;
    sending = true;
    try {
      await vmApi.remove(host.id, typed.trim());
      toast.success(fmt(i18n.t.vm.remove.accepted, { name }));
      open = false;
      await onDone();
    } catch (error) {
      toast.error(power?.describe(error) ?? String(error));
    } finally {
      sending = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="vm-delete">
    <Dialog.Header>
      <Dialog.Title>{fmt(i18n.t.vm.remove.title, { name })}</Dialog.Title>
      <Dialog.Description>{fmt(i18n.t.vm.remove.body, { provider: host.vm?.provider.name ?? "" })}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <div class="flex flex-col gap-1.5">
        <Label for="vm-delete-name">{fmt(i18n.t.vm.remove.typeName, { name })}</Label>
        <Input id="vm-delete-name" bind:value={typed} autocomplete="off" spellcheck="false" data-testid="vm-delete-name" />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>{i18n.t.vm.confirm.cancel}</Button>
        <Button type="submit" variant="destructive" disabled={sending || typed.trim() !== name} data-testid="vm-delete-confirm">
          {i18n.t.vm.remove.action}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
