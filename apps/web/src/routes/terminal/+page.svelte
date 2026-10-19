<script lang="ts">
  /**
   * One terminal, one window.
   *
   * It renders the SAME `TerminalGrid` as the dashboard with a single-cell layout
   * rather than a bespoke pane: the pane's keyboard handling, resize, click guard and
   * reconnection notices are worth exactly as much in a detached window, and a second
   * implementation would drift from the first.
   */
  import "@pdmux/ui/styles.css";
  import "@xterm/xterm/css/xterm.css";
  import { onDestroy, untrack } from "svelte";
  import { browser } from "$app/env";
  import { replaceState } from "$app/navigation";
  import type { TerminalPaneActionContext } from "@pdmux/ui";
  import TerminalPaneActions from "#lib/dashboard/components/terminal-pane-actions.svelte";
  import SessionTerminateDialog from "#lib/dashboard/components/session-terminate-dialog.svelte";
  import { TerminalGrid } from "@pdmux/ui";
  import { type SlotKind, type TerminalLayout, type TerminalSlot, defaultLayout, focusSlot } from "@pdmux/core";
  import { getI18n } from "#lib/i18n/index.js";
  import { TerminalRelay, defaultRelayUrl, type RelayStatus } from "#lib/dashboard/terminal-relay.js";
  import { uiTranslate } from "#lib/dashboard/ui-i18n.js";
  import { readTerminalHistory } from "#lib/dashboard/terminal-history.js";

  let {
    data,
  }: { data: { hostId: string; kind: SlotKind; session: string | null; hostLabel: string; backend?: "native"; sessionId?: string } } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));
  let terminating = $state<TerminalSlot | null>(null);
  let terminateOpen = $state(false);
  let relayStatus = $state<RelayStatus>("idle");

  const relay = new TerminalRelay({
    url: browser ? defaultRelayUrl(window.location) : "",
    messages: {
      reconnecting: i18n.t.dash.terminal.reconnecting,
      hostOffline: i18n.t.dash.terminal.hostOffline,
      restored: i18n.t.dash.terminal.restored,
      dropped: (bytes: number) => i18n.t.dash.terminal.dropped.replace("{count}", String(bytes)),
    },
    onStatus: (status: RelayStatus) => (relayStatus = status),
  });

  // The target is fixed for the lifetime of this window: it came from the URL, and a
  // layout object that changed identity would tear the terminal down and reconnect it.
  // Focus is the exception — the pane's click guard hands the keyboard over, and
  // without somewhere to record that, a detached window would never accept a key.
  let layout = $state<TerminalLayout>(
    untrack(() => ({
      ...defaultLayout(),
      mode: "tab" as const,
      sidebarOpen: false,
      dockOpen: false,
      focusId: "detached",
      slots: data.hostId
        ? [{ id: "detached", hostId: data.hostId, kind: data.kind, session: data.session, ...(data.backend ? { backend: data.backend } : {}), ...(data.sessionId ? { sessionId: data.sessionId } : {}) }]
        : [],
    })),
  );
  const hosts = untrack(() => [{ id: data.hostId, name: data.hostLabel, online: true }]);

  onDestroy(() => relay.dispose());
</script>

{#snippet paneActions(actions: TerminalPaneActionContext)}<TerminalPaneActions {actions} />{/snippet}
<SessionTerminateDialog bind:open={terminateOpen} slot={terminating} />

<svelte:head><title>{data.hostLabel} · {i18n.t.dash.terminal.detached}</title></svelte:head>

<div class="pdmux pdmux-panel" style="height:100dvh" data-testid="detached-terminal">
  {#if !data.hostId}
    <p class="pdmux-meta">{i18n.t.dash.terminal.missingTarget}</p>
  {:else}
    {#if relayStatus === "reconnecting"}
      <p class="text-destructive text-xs" data-testid="relay-status">{i18n.t.dash.terminal.reconnecting}</p>
    {/if}
    <TerminalGrid
      {layout}
      {hosts}
      adapter={relay}
      {paneActions}
      onReadHistory={readTerminalHistory}
      onSessionResolved={(slotId: string, sessionId: string) => {
        const slot = layout.slots.find(item => item?.id === slotId);
        if (slot?.sessionId === sessionId) return;
        layout = { ...layout, slots: layout.slots.map(item => item?.id === slotId ? { ...item, backend: "native", sessionId, kind: "attach", intent: "attach" } : item) };
        const url = new URL(window.location.href);
        url.searchParams.set("backend", "native");
        url.searchParams.set("kind", "attach");
        url.searchParams.set("sessionId", sessionId);
        replaceState(url, {});
      }}
      onTerminateSession={(slot: TerminalSlot) => { terminating = slot; terminateOpen = true; }}
      {t}
      onFocus={(slotId: string) => (layout = focusSlot(layout, slotId))}
      onZoom={(slotId: string) => (layout = focusSlot(layout, slotId))}
    />
  {/if}
</div>
