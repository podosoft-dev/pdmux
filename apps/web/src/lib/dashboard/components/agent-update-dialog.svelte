<script lang="ts">
  /**
   * Confirm an agent update, in numbers.
   *
   * WHY NUMBERS AND NOT A WARNING: "this may disconnect terminals" is true of every
   * update, so it is read once and clicked through forever. "2 shell panes will be
   * terminated; 3 session panes will re-attach" is a different sentence every time,
   * and the two halves are not the same risk — a restart kills plain shells and
   * everything running under them, while a multiplexer session survives it and the
   * pane comes back.
   *
   * WHY THE SECOND STEP: shell panes are the only unrecoverable half. When there are
   * none, one click is proportionate; when there are some, the operator is asked
   * again in the words of what they are about to lose. The gate is on the count, not
   * on a preference, so it cannot be turned off into irrelevance.
   */
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { fmt, getI18n } from "$lib/i18n";
  import { panePlan, type PaneSlot } from "$lib/dashboard/agent-update";
  import type { HostView } from "$lib/dashboard/types";

  let {
    open = $bindable(false),
    host,
    /** The terminal panes this browser has open, so the count includes what is on screen. */
    slots = [],
    onConfirm,
  }: {
    open?: boolean;
    host: HostView | null;
    slots?: readonly PaneSlot[];
    onConfirm: (host: HostView) => void | Promise<void>;
  } = $props();

  const i18n = getI18n();
  let armed = $state(false);
  let busy = $state(false);

  const plan = $derived(host ? panePlan(host, slots) : { shellPanes: 0, sessionPanes: 0 });
  const target = $derived(host?.latestAgentVersion ?? "");
  /** Nothing is lost, so nothing further is asked. */
  const needsSecondStep = $derived(plan.shellPanes > 0);

  // A reopened dialog must never start already armed.
  $effect(() => {
    if (!open) armed = false;
  });

  async function confirm(): Promise<void> {
    if (!host || busy) return;
    if (needsSecondStep && !armed) {
      armed = true;
      return;
    }
    busy = true;
    try {
      await onConfirm(host);
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="agent-update-dialog">
    <Dialog.Header>
      <Dialog.Title>{fmt(i18n.t.dash.agent.updateTitle, { label: host?.label ?? "" })}</Dialog.Title>
      <Dialog.Description>
        {fmt(i18n.t.dash.agent.updateFromTo, { from: host?.agentVersion ?? "—", to: target || "—" })}
      </Dialog.Description>
    </Dialog.Header>

    <p class="text-sm" data-testid="agent-update-panes">
      {fmt(i18n.t.dash.agent.paneCounts, { shell: plan.shellPanes, session: plan.sessionPanes })}
    </p>

    {#if armed}
      <p class="text-destructive text-sm" data-testid="agent-update-second">
        {fmt(i18n.t.dash.agent.shellWarning, { shell: plan.shellPanes })}
      </p>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)} data-testid="agent-update-cancel">
        {i18n.t.dash.form.cancel}
      </Button>
      <Button
        variant={armed ? "destructive" : "default"}
        disabled={busy || !host}
        onclick={confirm}
        data-testid={armed ? "agent-update-confirm-shells" : "agent-update-confirm"}
      >
        {armed ? i18n.t.dash.agent.confirmShells : i18n.t.dash.agent.update}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
