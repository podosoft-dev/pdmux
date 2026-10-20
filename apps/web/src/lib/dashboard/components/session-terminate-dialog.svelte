<script lang="ts">
  import type { TerminalSlot } from "@pdmux/core";
  import { toast } from "svelte-sonner";
  import { getI18n } from "#lib/i18n/index.js";
  import { terminalApi } from "../api.js";
  import ConfirmDialog from "./confirm-dialog.svelte";

  let { open = $bindable(false), slot, hostName, onTerminated }: { open?: boolean; slot: TerminalSlot | null; hostName?: string; onTerminated?: () => Promise<void> } = $props();
  const i18n = getI18n();
  async function terminate(): Promise<boolean> {
    if ((!slot?.sessionId && !slot?.tmuxId) || !slot?.session) return false;
    try { await terminalApi.terminate(slot.hostId, slot.session, slot.sessionId, slot.tmuxId); }
    catch { toast.error(i18n.t.pdmux.pane.terminateFailed); return false; }
    await onTerminated?.();
    return true;
  }
</script>

<ConfirmDialog bind:open title={i18n.t.pdmux.pane.terminateTitle} warning={i18n.t.pdmux.pane.terminateWarning} confirmLabel={i18n.t.pdmux.pane.terminate} testId="session-terminate-confirm" onConfirm={terminate}>
  {#snippet details()}<p class="break-all font-medium" data-testid="session-terminate-target">{hostName ? `${hostName} · ` : ""}{slot?.session}</p>{/snippet}
</ConfirmDialog>
