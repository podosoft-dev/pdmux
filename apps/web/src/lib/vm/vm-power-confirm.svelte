<script lang="ts">
  /**
   * The screen's one confirmation for a power change.
   *
   * It says who will be cut off — the multiplexer's attached clients on the machine, and how
   * many of them are this screen's panes — because an organization member may restart a
   * machine a colleague is working on (2026-10-19 decision), and "are you sure?" without the
   * number gives them nothing to be sure about.
   */
  import ConfirmDialog from "#lib/dashboard/components/confirm-dialog.svelte";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { attachedClients } from "./power";
  import type { VmPowerController } from "./power-controller.svelte";

  let {
    power,
    panesOn,
  }: {
    power: VmPowerController;
    /** How many of this screen's panes point at a host. */
    panesOn: (hostId: string) => number;
  } = $props();

  const i18n = getI18n();
  const pending = $derived(power.pending);
  let open = $state(false);
  $effect(() => {
    open = pending !== null;
  });
  $effect(() => {
    if (!open && power.pending) power.cancel();
  });

  const title = $derived(pending
    ? fmt(i18n.t.vm.confirm.title, { action: i18n.t.vm.action[pending.item.label], name: pending.host.vm?.name ?? pending.host.label })
    : "");
  const warning = $derived.by(() => {
    if (!pending) return "";
    // The heartbeat's count lags a fresh attach by up to one beat (measured: two new panes read as
    // zero), so this screen's own panes are a floor — never tell someone "nobody" while they look at two.
    const mine = panesOn(pending.host.id);
    const attached = Math.max(attachedClients(pending.host.sessions ?? []), mine);
    const cut = attached > 0
      ? fmt(i18n.t.vm.confirm.attached, { attached, mine })
      : i18n.t.vm.confirm.noneAttached;
    const hint = i18n.t.vm.hint[pending.item.label];
    return pending.item.confirm === "warn" ? `${hint}. ${i18n.t.vm.confirm.forced} ${cut}` : `${hint}. ${cut}`;
  });
</script>

<ConfirmDialog
  bind:open
  {title}
  {warning}
  confirmLabel={pending ? i18n.t.vm.action[pending.item.label] : undefined}
  testId="vm-power-confirm"
  onConfirm={() => power.confirm()}
/>
