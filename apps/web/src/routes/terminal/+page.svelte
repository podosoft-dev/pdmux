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
  import { TerminalGrid } from "@pdmux/ui";
  import { type SlotKind, type TerminalLayout, defaultLayout, focusSlot } from "@pdmux/core";
  import { getI18n } from "#lib/i18n/index.js";
  import { TerminalRelay, defaultRelayUrl, type RelayStatus } from "#lib/dashboard/terminal-relay.js";
  import { uiTranslate } from "#lib/dashboard/ui-i18n.js";

  let {
    data,
  }: { data: { hostId: string; kind: SlotKind; session: string | null; hostLabel: string } } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));
  let relayStatus = $state<RelayStatus>("idle");

  const relay = new TerminalRelay({
    url: browser ? defaultRelayUrl(window.location) : "",
    messages: {
      reconnecting: i18n.t.dash.terminal.reconnecting,
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
        ? [{ id: "detached", hostId: data.hostId, kind: data.kind, session: data.session }]
        : [],
    })),
  );
  const hosts = untrack(() => [{ id: data.hostId, name: data.hostLabel, online: true }]);

  onDestroy(() => relay.dispose());
</script>

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
      {t}
      onFocus={(slotId: string) => (layout = focusSlot(layout, slotId))}
      onZoom={(slotId: string) => (layout = focusSlot(layout, slotId))}
    />
  {/if}
</div>
