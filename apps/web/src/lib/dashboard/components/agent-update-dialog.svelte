<script lang="ts">
  /**
   * The modal chrome around the shared confirmation body.
   *
   * Everything that decides anything — the pane counts, the second step gated on
   * `shellPanes > 0`, the probation sentence — is in `agent-update-confirm.svelte`,
   * because the sidebar popover shows the same thing and a second implementation
   * would be a second, weaker door to the same destructive action.
   */
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import type { PaneSlot } from "#lib/dashboard/agent-update.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import AgentUpdateConfirm from "./agent-update-confirm.svelte";

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
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="agent-update-dialog">
    <Dialog.Header>
      <Dialog.Title>{fmt(i18n.t.dash.agent.updateTitle, { label: host?.label ?? "" })}</Dialog.Title>
    </Dialog.Header>

    <AgentUpdateConfirm
      {host}
      {slots}
      onCancel={() => (open = false)}
      onConfirm={async (target) => {
        await onConfirm(target);
        open = false;
      }}
    />
  </Dialog.Content>
</Dialog.Root>
