<script lang="ts">
  import { desktopTerminalSurface } from "#lib/desktop/terminal-preferences.svelte.js";
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
  import { onDestroy, onMount, untrack } from "svelte";
  import { browser } from "$app/env";
  import { replaceState } from "$app/navigation";
  import type { TerminalPaneActionContext } from "@pdmux/ui";
  import TerminalPaneActions from "#lib/dashboard/components/terminal-pane-actions.svelte";
  import TerminalPaneWarning from "#lib/dashboard/components/terminal-pane-warning.svelte";
  import SessionTerminateDialog from "#lib/dashboard/components/session-terminate-dialog.svelte";
  import SessionManagerDialog from "#lib/dashboard/components/session-manager-dialog.svelte";
  import SessionRenameDialog from "#lib/dashboard/components/session-rename-dialog.svelte";
  import TerminalPresentationDialog from "#lib/dashboard/components/terminal-presentation-dialog.svelte";
  import { TerminalGrid } from "@pdmux/ui";
  import { type SlotKind, type TerminalLayout, type TerminalSlot, type TerminalPresentation, defaultLayout, focusSlot, setSlotPresentation, slotLabel, resolveSessionSlot, adoptNativeSession, renameSlotSessions } from "@pdmux/core";
  import { getI18n } from "#lib/i18n/index.js";
  import { TerminalRelay, defaultRelayUrl, type RelayStatus } from "#lib/dashboard/terminal-relay.js";
  import { uiTranslate } from "#lib/dashboard/ui-i18n.js";
  import { hostsApi } from "#lib/dashboard/api.js";
  import { FleetEvents } from "#lib/dashboard/fleet-events.js";
  import { ServerConnection, TransportLoss, isServerUnreachable } from "#lib/dashboard/server-connection.svelte.js";
  import { gridHosts } from "#lib/dashboard/map.js";
  import { readTerminalHistory } from "#lib/dashboard/terminal-history.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import { VmPowerController, provideVmPower } from "#lib/vm/power-controller.svelte.js";
  import VmPowerConfirm from "#lib/vm/vm-power-confirm.svelte";
  import VmPaneVeil from "#lib/vm/vm-pane-veil.svelte";

  let {
    data,
  }: {
    data: { hostId: string; kind: SlotKind; session: string | null; hostLabel: string; host: HostView | null; backend?: "native"; sessionId?: string; tmuxId?: string; canManage?: boolean; presentation?: TerminalPresentation };
  } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));
  let terminating = $state<TerminalSlot | null>(null);
  let terminateOpen = $state(false);
  let presentationOpen = $state(false);
  let renameOpen = $state(false);
  let sessionsOpen = $state(false);
  let renaming = $state<TerminalSlot | null>(null);
  let relayStatus = $state<RelayStatus>("idle");
  // The same two signals as the dashboard: is the server there, and is this host's socket.
  const connection = new ServerConnection();
  const transportLoss = new TransportLoss();

  const relay = new TerminalRelay({
    url: browser ? defaultRelayUrl(window.location) : "",
    messages: {
      reconnecting: i18n.t.dash.terminal.reconnecting,
      hostOffline: i18n.t.dash.terminal.hostOffline,
      restored: i18n.t.dash.terminal.restored,
      dropped: (bytes: number) => i18n.t.dash.terminal.dropped.replace("{count}", String(bytes)),
      sessionMissing: i18n.t.pdmux.pane.restoredMissing,
    },
    onStatus: (status: RelayStatus) => (relayStatus = status),
    onHostStatus: (hostId: string, status: RelayStatus) => transportLoss.note(hostId, status),
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
        ? [{ id: "detached", hostId: data.hostId, kind: data.kind, session: data.session, ...data.presentation, ...(data.backend ? { backend: data.backend } : {}), ...(data.sessionId ? { sessionId: data.sessionId } : {}), ...(data.tmuxId ? { tmuxId: data.tmuxId } : {}) }]
        : [],
    })),
  );
  /**
   * The host as the server last described it.
   *
   * ⚠ THIS WINDOW USED TO CALL ITS HOST ONLINE FOR EVER. With no feed of its own it hard-coded
   * `online: true`, so a machine that powered off left a pane that looked alive and swallowed
   * keystrokes, and a machine that came back was not noticed until the backoff happened to
   * retry. It now reads the one host it shows — on the fleet's invalidation events and at the
   * heartbeat pace the dashboard polls at — and only falls back to "online" before the first
   * answer, which is what it showed before.
   */
  let host = $state<HostView | null>(untrack(() => data.host));
  /** When the host was last read — the clock a change in flight counts its seconds from, as the dashboard's feed is. */
  let now = $state(Date.now());
  const canManage = $derived(data.canManage === true);
  const hosts = $derived(
    host ? gridHosts([host]) : [{ id: untrack(() => data.hostId), name: untrack(() => data.hostLabel), online: true }],
  );
  $effect(() => {
    relay.noteReachable(hosts.filter((entry) => entry.online).map((entry) => entry.id));
  });

  $effect(() => {
    const currentHosts = hosts;
    untrack(() => {
      const slots = layout.slots.map(slot => slot ? resolveSessionSlot(slot, currentHosts) : null);
      if (slots.some((slot, index) => slot !== layout.slots[index])) {
        layout = { ...layout, slots };
        const slot = slots[0];
        if (slot?.tmuxId) {
          const url = new URL(window.location.href);
          url.searchParams.set("tmuxId", slot.tmuxId);
          if (slot.session) url.searchParams.set("session", slot.session);
          replaceState(url, {});
        }
      }
    });
  });

  /** A rename made from this window carries into its slot and its URL. */
  function renamedHere(renamed: { hostId: string; sessionId?: string; tmuxId?: string; name: string }): void {
    const next = renameSlotSessions(layout, renamed.hostId, renamed, renamed.name);
    if (next === layout) return;
    layout = next;
    const url = new URL(window.location.href);
    url.searchParams.set("session", renamed.name);
    replaceState(url, {});
  }

  async function readHost(): Promise<void> {
    if (!data.hostId) return;
    try {
      host = await hostsApi.get(data.hostId);
      connection.alive();
    } catch (cause: unknown) {
      // A failed read keeps the last answer on screen, as the dashboard's feed does — and,
      // like it, stops vouching for that answer while the server is away.
      if (isServerUnreachable(cause)) connection.lost();
      else connection.alive();
    } finally {
      now = Date.now();
    }
  }
  const events = new FleetEvents(readHost, readHost, { connection });
  connection.onRecover(() => void readHost());

  /**
   * The same power controls as the dashboard's panes. The window shows one pane, so the
   * confirmation counts it as the one terminal of this screen that a change would cut.
   */
  const vmPower = provideVmPower(new VmPowerController({
    refresh: readHost,
    messages: () => i18n.t,
    canManage: () => canManage,
  }));
  let poll: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    events.start();
    void readHost();
    poll = setInterval(() => void readHost(), 5_000);
  });

  onDestroy(() => {
    events.stop();
    if (poll) clearInterval(poll);
    relay.dispose();
    transportLoss.dispose();
    connection.dispose();
  });
</script>

{#snippet paneWarning()}<TerminalPaneWarning />{/snippet}

{#snippet paneActions(actions: TerminalPaneActionContext)}<TerminalPaneActions {actions} standalone host={host ?? undefined} {canManage} {now} onManageSessions={() => sessionsOpen = true} onRenameSession={(slot) => { renaming = slot; renameOpen = true; }} onEditPresentation={() => presentationOpen = true} />{/snippet}
{#snippet paneVeil(_actions: TerminalPaneActionContext)}<VmPaneVeil host={host ?? undefined} {canManage} {now} />{/snippet}
<SessionTerminateDialog bind:open={terminateOpen} slot={terminating} />
<SessionManagerDialog bind:open={sessionsOpen} onChanged={(renamed) => { if (renamed) renamedHere(renamed); return readHost(); }} />
<SessionRenameDialog bind:open={renameOpen} slot={renaming} onRenamed={(renamed) => { renamedHere(renamed); return readHost(); }} />
<TerminalPresentationDialog bind:open={presentationOpen} value={layout.slots[0]} onSave={(value) => {
  layout = setSlotPresentation(layout, "detached", value);
  const url = new URL(window.location.href);
  if (value.label) url.searchParams.set("label", value.label); else url.searchParams.delete("label");
  if (value.tags?.length) url.searchParams.set("tags", JSON.stringify(value.tags)); else url.searchParams.delete("tags");
  replaceState(url, {});
}} />
<VmPowerConfirm power={vmPower} panesOn={(hostId: string) => (hostId === data.hostId ? 1 : 0)} />
<Toaster />

<svelte:head><title>{layout.slots[0] ? slotLabel(layout.slots[0], data.hostLabel) : data.hostLabel} · PDMux</title></svelte:head>

<div class="pdmux pdmux-panel" style="height:100dvh" data-testid="detached-terminal">
  {#if !data.hostId}
    <p class="pdmux-meta">{i18n.t.dash.terminal.missingTarget}</p>
  {:else}
    {#if relayStatus === "reconnecting"}
      <p class="text-destructive text-xs" data-testid="relay-status">{i18n.t.dash.terminal.reconnecting}</p>
    {/if}
    <TerminalGrid
    createSurface={desktopTerminalSurface}
      {layout}
      {hosts}
      adapter={relay}
      {paneActions}
      {paneWarning}
      {paneVeil}
      onReadHistory={readTerminalHistory}
      onSessionResolved={(slotId: string, sessionId: string) => {
        const next = adoptNativeSession(layout, slotId, sessionId);
        if (next === layout) return;
        layout = next;
        const url = new URL(window.location.href);
        url.searchParams.set("backend", "native");
        url.searchParams.set("kind", "attach");
        url.searchParams.set("sessionId", sessionId);
        url.searchParams.delete("tmuxId");
        replaceState(url, {});
      }}
      onTerminateSession={(slot: TerminalSlot) => { terminating = slot; terminateOpen = true; }}
      {t}
      onFocus={(slotId: string) => (layout = focusSlot(layout, slotId))}
      onZoom={(slotId: string) => (layout = focusSlot(layout, slotId))}
      transport={relayStatus}
      connectionLostFor={(hostId: string) => !connection.online || transportLoss.lost[hostId] === true}
    />
  {/if}
</div>
