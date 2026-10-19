<script lang="ts">
  import type { TerminalSlot } from "@pdmux/core";
  import { toast } from "svelte-sonner";
  import { getI18n } from "#lib/i18n/index.js";
  import { terminalApi } from "../api.js";
  import ConfirmDialog from "./confirm-dialog.svelte";

  let { open = $bindable(false), slot }: { open?: boolean; slot: TerminalSlot | null } = $props();
  const i18n = getI18n();
  async function terminate(): Promise<boolean> {
    if (!slot?.sessionId || !slot.session) return false;
    try { await terminalApi.terminate(slot.hostId, slot.session, slot.sessionId); }
    catch { toast.error(i18n.t.pdmux.pane.terminateFailed); return false; }
    return true;
  }
</script>

<ConfirmDialog bind:open title={i18n.t.pdmux.pane.terminateTitle} warning={i18n.t.pdmux.pane.terminateWarning} confirmLabel={i18n.t.pdmux.pane.terminate} testId="session-terminate-confirm" onConfirm={terminate} />
