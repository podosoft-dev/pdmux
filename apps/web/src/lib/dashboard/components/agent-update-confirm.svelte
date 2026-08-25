<script lang="ts">
  /**
   * Confirm an agent update, in numbers. The BODY only — two screens wrap it in
   * different chrome (a modal on the fleet pages, a popover on the sidebar).
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
   *
   * ⚠ WHICH IS EXACTLY WHY THIS FILE EXISTS. A second confirmation UI that
   * reimplemented `shellPanes > 0` would be a weaker door to the same destructive
   * action, and the weaker one is the one people would end up using. One body, two
   * frames.
   *
   * ⚠ EVERY `data-testid` HERE WAS MOVED VERBATIM FROM THE DIALOG. The existing e2e
   * passing unchanged is the evidence that the extraction was faithful; renaming one
   * would make that evidence disappear.
   */
  import { Button } from "#lib/components/ui/button/index.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { panePlan, type PaneSlot } from "#lib/dashboard/agent-update.js";
  import type { HostView } from "#lib/dashboard/types.js";

  let {
    host,
    /** The terminal panes this browser has open, so the count includes what is on screen. */
    slots = [],
    onConfirm,
    onCancel,
  }: {
    host: HostView | null;
    slots?: readonly PaneSlot[];
    onConfirm: (host: HostView) => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  const i18n = getI18n();
  let armed = $state(false);
  let busy = $state(false);

  const plan = $derived(host ? panePlan(host, slots) : { shellPanes: 0, sessionPanes: 0 });
  const target = $derived(host?.latestAgentVersion ?? "");
  /** Nothing is lost, so nothing further is asked. */
  const needsSecondStep = $derived(plan.shellPanes > 0);

  /** A body mounted for a different host must never start already armed. */
  $effect(() => {
    void host?.id;
    armed = false;
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
    } finally {
      busy = false;
    }
  }
</script>

<p class="text-muted-foreground text-sm">
  {fmt(i18n.t.dash.agent.updateFromTo, { from: host?.agentVersion ?? "—", to: target || "—" })}
</p>

<p class="text-sm" data-testid="agent-update-panes">
  {fmt(i18n.t.dash.agent.paneCounts, { shell: plan.shellPanes, session: plan.sessionPanes })}
</p>

<!--
  The reassurance the operator actually needs before pressing an irreversible-looking
  button: the agent proves the new binary can connect before swapping, and restores
  the old one if it cannot. The string already existed and was only reachable as a
  tooltip on the `restarting` phase — putting it here means the fleet pages gain it
  too, which is right. It is not sidebar-specific.
-->
<p class="text-muted-foreground text-xs" data-testid="agent-update-probation">
  {i18n.t.dash.agent.probation}
</p>

{#if armed}
  <p class="text-destructive text-sm" data-testid="agent-update-second">
    {fmt(i18n.t.dash.agent.shellWarning, { shell: plan.shellPanes })}
  </p>
{/if}

<div class="flex justify-end gap-2">
  <Button variant="outline" size="sm" onclick={onCancel} data-testid="agent-update-cancel">
    {i18n.t.dash.form.cancel}
  </Button>
  <Button
    variant={armed ? "destructive" : "default"}
    size="sm"
    disabled={busy || !host}
    onclick={confirm}
    data-testid={armed ? "agent-update-confirm-shells" : "agent-update-confirm"}
  >
    {armed ? i18n.t.dash.agent.confirmShells : i18n.t.dash.agent.update}
  </Button>
</div>
