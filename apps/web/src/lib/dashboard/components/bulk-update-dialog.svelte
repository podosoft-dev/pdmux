<script lang="ts">
  /**
   * Confirm an update across a SELECTION, by naming every host in it.
   *
   * WHY THE LIST IS THE DIALOG: selection is free now — every row can be ticked,
   * including hosts an update would pass over — and that freedom is only honest if
   * the confirmation says which of them it is actually going to move. An operator
   * who ticks eleven rows and is told afterwards that three updated has been given
   * the outcome of something they never agreed to. The same person shown "3 will
   * update, 8 skipped: 6 already current, 2 offline" is making the decision.
   *
   * ⚠ THE SKIPPED HALF IS NOT DECORATION. It is where the rule that used to live in
   * a disabled checkbox now lives: a batch still refuses to guess at a host whose
   * version it cannot read, and this is the only place that refusal becomes visible
   * rather than being a control that will not click and does not say why.
   *
   * The pane counts and the second step are the single-host dialog's, deliberately
   * unchanged: a restart kills plain shells and everything under them while a
   * multiplexer session re-attaches, and that asymmetry does not become less true
   * when it is happening on six machines at once. The gate is on the count, so it
   * cannot be configured away.
   */
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { canaryNeeded, panePlan, planBulkUpdate, type PaneSlot } from "#lib/dashboard/agent-update.js";
  import type { HostView } from "#lib/dashboard/types.js";

  let {
    open = $bindable(false),
    hosts = [],
    fleet = [],
    /** The panes this browser has open, so the count includes what is on screen. */
    slots = [],
    onConfirm,
  }: {
    open?: boolean;
    hosts?: readonly HostView[];
    /** The whole fleet, for the canary check — the selection is not enough to answer it. */
    fleet?: readonly HostView[];
    slots?: readonly PaneSlot[];
    onConfirm: (hosts: HostView[], version: string) => void | Promise<void>;
  } = $props();

  const i18n = getI18n();
  let armed = $state(false);
  let busy = $state(false);

  const plan = $derived(planBulkUpdate(hosts));
  /** Summed across the hosts that will actually be sent — the skipped ones lose nothing. */
  const panes = $derived(
    plan.updatable.reduce(
      (total, host) => {
        const one = panePlan(host, slots);
        return { shellPanes: total.shellPanes + one.shellPanes, sessionPanes: total.sessionPanes + one.sessionPanes };
      },
      { shellPanes: 0, sessionPanes: 0 },
    ),
  );
  /**
   * The server refuses a batch to a version no host runs yet, and it is right to. Saying
   * so here rather than in a toast afterwards is the difference between a rule and a
   * wasted click — measured on a real rollout, where pressing update on a fresh release
   * looked like it did nothing at all.
   */
  const canary = $derived(canaryNeeded(fleet, plan.version));
  const ready = $derived(plan.updatable.length > 0 && plan.version !== null && !canary);
  const needsSecondStep = $derived(panes.shellPanes > 0);

  // A reopened dialog must never start already armed.
  $effect(() => {
    if (!open) armed = false;
  });

  async function confirm(): Promise<void> {
    if (!ready || busy) return;
    if (needsSecondStep && !armed) {
      armed = true;
      return;
    }
    busy = true;
    try {
      await onConfirm(plan.updatable, plan.version as string);
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="bulk-update-dialog">
    <Dialog.Header>
      <Dialog.Title>{fmt(i18n.t.dash.agent.bulkUpdateTitle, { count: hosts.length })}</Dialog.Title>
      <Dialog.Description data-testid="bulk-update-target">
        {#if plan.version}
          {fmt(i18n.t.dash.agent.bulkUpdateTo, { version: plan.version })}
        {:else if plan.conflict.length > 0}
          <!-- One version travels for the whole batch while the newest build is resolved
               per (os, arch). Picking a winner would ask half of them for a build that
               does not exist for their platform. -->
          {fmt(i18n.t.dash.agent.bulkMixed, { versions: plan.conflict.join(", ") })}
        {:else}
          {i18n.t.dash.agent.bulkNothing}
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <!-- Bounded and scrollable: a fleet selection is not a fixed length, and a dialog
         that grows past the viewport puts its own confirm button off screen. -->
    <div class="max-h-64 space-y-3 overflow-y-auto text-sm">
      {#if plan.updatable.length > 0}
        <div data-testid="bulk-update-list">
          <p class="text-muted-foreground mb-1 text-xs font-medium">
            {fmt(i18n.t.dash.agent.bulkWillUpdate, { count: plan.updatable.length })}
          </p>
          <ul class="space-y-0.5">
            {#each plan.updatable as host (host.id)}
              <li class="flex items-center justify-between gap-3">
                <span class="truncate font-medium">{host.label}</span>
                <span class="text-muted-foreground shrink-0 tabular-nums">
                  {fmt(i18n.t.dash.agent.updateFromTo, {
                    from: host.agentVersion ?? "—",
                    to: host.latestAgentVersion ?? "—",
                  })}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if plan.skipped.length > 0}
        <div data-testid="bulk-update-skipped">
          <p class="text-muted-foreground mb-1 text-xs font-medium">
            {fmt(i18n.t.dash.agent.bulkSkipped, { count: plan.skipped.length })}
          </p>
          <ul class="text-muted-foreground space-y-0.5">
            {#each plan.skipped as entry (entry.host.id)}
              <li class="flex items-center justify-between gap-3">
                <span class="truncate">{entry.host.label}</span>
                <span class="shrink-0">{i18n.t.dash.agent.skip[entry.reason]}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    {#if canary}
      <p class="text-destructive text-sm" data-testid="bulk-update-canary">
        {i18n.t.dash.agent.noCanary}
      </p>
    {/if}

    {#if ready}
      <p class="text-sm" data-testid="bulk-update-panes">
        {fmt(i18n.t.dash.agent.paneCounts, { shell: panes.shellPanes, session: panes.sessionPanes })}
      </p>
    {/if}

    {#if armed}
      <p class="text-destructive text-sm" data-testid="bulk-update-second">
        {fmt(i18n.t.dash.agent.shellWarning, { shell: panes.shellPanes })}
      </p>
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)} data-testid="bulk-update-cancel">
        {i18n.t.dash.form.cancel}
      </Button>
      <Button
        variant={armed ? "destructive" : "default"}
        disabled={busy || !ready}
        onclick={confirm}
        data-testid={armed ? "bulk-update-confirm-shells" : "bulk-update-confirm"}
      >
        {armed ? i18n.t.dash.agent.confirmShells : i18n.t.dash.agent.update}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
