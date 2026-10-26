<script lang="ts">
  /**
   * The product shell: host cards │ splitter │ whatever the route puts on the right.
   *
   * THE SIDEBAR IS CHROME, NOT A PAGE. It used to belong to the dashboard, which made
   * the fleet invisible the moment you opened host management and re-seeded it (cards,
   * poll, widths) on the way back. Here it is mounted once for the whole group, so
   * `/hosts` renders inside the same frame the terminals do and the cards keep ticking
   * while you work on them.
   *
   * ⚠ THE PAGE MUST NOT SCROLL. The shell is a 100dvh grid and each column scrolls
   * itself; a document-level scrollbar is the exact signature of the layout bug that
   * once pushed the commit detail ~7,300px below the fold (ARCHITECTURE §7).
   */
  import "@pdmux/ui/styles.css";
  import { onDestroy, onMount, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { beforeNavigate, goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { CardSettingsPopover, HostSidebar, ShellViewTabs, SplitHandle } from "@pdmux/ui";
  import {
    type CardWidget,
    cardCollapsed,
    cardPrefs,
    freshMetrics,
    SHELL_STACK_MAX_WIDTH,
    setSidebarWidth,
    renameSlotSessions,
  } from "@pdmux/core";
  import LanguageSwitch from "#lib/components/language-switch.svelte";
  import ImpersonationBanner from "#lib/components/impersonation-banner.svelte";
  import ThemeToggle from "#lib/components/theme-toggle.svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import { fmt, formatDateTime, getI18n } from "#lib/i18n/index.js";
  import HostFormDialog from "#lib/dashboard/components/host-form-dialog.svelte";
  import ShellUserMenu from "#lib/dashboard/components/shell-user-menu.svelte";
  import { dismissOnOutside } from "#lib/dashboard/popover-dismiss.svelte.ts";
  import { selectView, syncViewFromHistory } from "#lib/dashboard/mobile-view.svelte.ts";
  import { trackVisualViewport } from "#lib/dashboard/visual-viewport.svelte.ts";
  import { type ShellView, provideShellState } from "#lib/dashboard/shell-state.svelte.ts";
  import {
    agentRowsFor,
    hostResources,
    hostSummary,
    metricsFeed,
    paneIndexesByHost,
    serviceOptionsFor,
  } from "#lib/dashboard/map.js";
  import { cardUpdate, paneSlots } from "#lib/dashboard/agent-update.js";
  import { relayMessages } from "#lib/dashboard/wording.js";
  import { agentUpdateApi } from "#lib/dashboard/api.js";
  import { agentUpdateMessage } from "#lib/dashboard/wording.js";
  import AgentUpdateConfirm from "#lib/dashboard/components/agent-update-confirm.svelte";
  import type { HostUpdateMark } from "@pdmux/ui";
  import { uiTranslate } from "#lib/dashboard/ui-i18n.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import { VmPowerController, provideVmPower } from "#lib/vm/power-controller.svelte.js";
  import VmPowerConfirm from "#lib/vm/vm-power-confirm.svelte";
  import { cardPowerKind, elapsedSeconds } from "#lib/vm/power.js";
  import type { HostPowerMark } from "@pdmux/ui";
  import type { LayoutData } from "./$types";
  import SessionManagerDialog from "#lib/dashboard/components/session-manager-dialog.svelte";
  import SettingsDialog from "#lib/settings/settings-dialog.svelte";
  import { provideSettings, settingsLocation } from "#lib/settings/settings-state.svelte.js";
  import { desktopActions } from "#lib/desktop.js";

  let { data, children }: { data: LayoutData; children: import("svelte").Snippet } = $props();

  const i18n = getI18n();
  let settingsView: ShellView | undefined;
  const settingsDialog = provideSettings({
    onOpen: () => { settingsView = shell.view; },
    onClose: () => {
      if (settingsView) {
        shell.view = settingsView;
        replaceState("", { ...page.state, pdmuxView: settingsView });
        settingsView = undefined;
      }
    },
  });
  beforeNavigate(navigation => {
    if (!navigation.to || navigation.willUnload) return;
    const location = settingsLocation(navigation.to.url);
    if (!location) return;
    navigation.cancel();
    const fleetTab = navigation.to.url.searchParams.get("tab");
    if (location.tab === "fleet" && fleetTab) {
      const url = new URL(page.url.href);
      url.searchParams.set("tab", fleetTab);
      replaceState(url, page.state);
    }
    if (location.target) settingsDialog.target = location.target;
    settingsDialog.show(location.tab, location.host ?? null);
  });
  $effect(() => {
    if (!page.url.searchParams.has("preferences")) return;
    const location = settingsLocation(new URL(page.url.href));
    if (!location) return;
    untrack(() => {
      if (location.target) settingsDialog.target = location.target;
      settingsDialog.show(location.tab, location.host ?? null);
      const url = new URL(page.url.href);
      for (const key of ["preferences", "host", "scope"]) url.searchParams.delete(key);
      replaceState(url, page.state);
    });
  });
  onMount(() => desktopActions()?.onSettings?.(() => settingsDialog.show()));
  const t = $derived(uiTranslate(i18n.t));
  $effect(() => { void shell.feed.hosts; untrack(() => shell.syncSessions()); });

  /**
   * `untrack` because these are seeds, not reactive inputs: the feed owns the host list
   * from its first poll onwards, and re-seeding it when a loader re-runs (a locale
   * switch invalidates everything) would throw away live data and re-mount terminals.
   */
  const shell = untrack(() =>
    provideShellState({
      hosts: data.hosts,
      hostsOk: data.hostsOk,
      prefs: data.prefs,
      prefsOk: data.prefsOk,
      fleet: data.fleet,
      // Read per notice: a locale switch must not leave the next notice in the old language.
      relayMessages: () => relayMessages(i18n.t),
    }),
  );

  // One power controller for every pane and card in the shell, and one confirmation.
  const vmPower = provideVmPower(new VmPowerController({
    refresh: () => shell.feed.refresh(),
    messages: () => i18n.t,
    canManage: () => data.canManage,
  }));

  const layout = $derived(shell.layout);
  /**
   * `data-dock` follows the dashboard's dock rather than the preference alone: the last
   * two grid tracks are filled by the dashboard page only, so leaving them open on
   * `/hosts` would reserve an empty ~420px column beside the host list.
   *
   * ⚠ EITHER PANEL OPENS THE TRACK. The column holds the commit graph and the file
   * explorer, and reading only `dockOpen` would give the explorer a zero-width column
   * whenever the graph was closed — visible as "the toggle does nothing".
   */
  const dockOpen = $derived(page.url.pathname === "/" && (layout.dockOpen || layout.filesOpen));

  const nowSeconds = $derived(Math.floor(shell.feed.now / 1000));
  const fresh = $derived(freshMetrics(metricsFeed(shell.feed.hosts, shell.feed.now), shell.feed.now));
  const freshById = $derived(new Map((fresh ?? []).map((row) => [row.id, row])));
  const windowLabels = $derived({
    session: i18n.t.dash.usageWindow.session,
    weekly: i18n.t.dash.usageWindow.weekly,
    monthly: i18n.t.dash.usageWindow.monthly,
  });

  /**
   * The card's one line, composed here because this is the only place that has both
   * the verdict (`cardUpdate`) and the catalogue (`fmt`). The package receives a
   * shape and a sentence, never a version string it would have to format.
   */
  function updateMark(host: HostView): HostUpdateMark | null {
    if (!data.canManage) return null;
    const verdict = cardUpdate(host);
    if (!verdict) return null;
    if (verdict.kind === "busy") {
      return {
        kind: "busy",
        // The phase word, never a percentage: `updateProgressPct` is only meaningful
        // while downloading and pins to 100 for the rest, so a number here would sit
        // frozen inside a tooltip nobody watches.
        label: fmt(i18n.t.dash.agent.cardUpdating, { phase: i18n.t.dash.agent.phase[verdict.phase as keyof typeof i18n.t.dash.agent.phase] }),
      };
    }
    const key = verdict.kind === "urgent" ? i18n.t.dash.agent.cardUpdateIncompatible : i18n.t.dash.agent.cardUpdate;
    return { kind: verdict.kind, label: fmt(key, { version: verdict.version }) };
  }

  /** The machine's line on its card, worded here for the same reason as `updateMark`. */
  function powerMark(host: HostView): HostPowerMark | null {
    const kind = cardPowerKind(host.vm);
    const vm = host.vm;
    if (!kind || !vm) return null;
    if (kind === "busy" && vm.operation) {
      const label = fmt(i18n.t.vm.progress, {
        operation: i18n.t.vm.operation[vm.operation.action],
        name: vm.operation.requestedBy.name ?? i18n.t.vm.someone,
        seconds: elapsedSeconds(vm, shell.feed.now),
      });
      return { kind, label };
    }
    if (kind === "error" && vm.error) return { kind, label: vmPower.describe(null, vm.error.code) };
    return { kind, label: `${i18n.t.vm.badge} · ${i18n.t.vm.state[vm.state]}` };
  }

  /**
   * ⚠ WHILE THE SERVER IS UNREACHABLE NO HOST IS ONLINE TO THIS SCREEN. The rows are the last
   * answer, kept so the column does not blank, but drawing them green with their last
   * percentages is exactly the lie an outage used to tell. Each card reads as unknown and the
   * column says why at its top.
   */
  const serverLost = $derived(!shell.feed.connection.online);
  /** Terminal cells per host, numbered as the pane headers number them (`#N` = index + 1). */
  const panesByHost = $derived(paneIndexesByHost(layout.slots));
  const cards = $derived(
    shell.orderedHosts.map((host) => ({
      host: serverLost
        ? { ...hostSummary(host, updateMark(host), powerMark(host)), state: "unknown" as const }
        : hostSummary(host, updateMark(host), powerMark(host)),
      agents: agentRowsFor(host, shell.providers, shell.feed.now, !serverLost && host.online),
      resources: hostResources(host, serverLost ? undefined : freshById.get(host.id), !serverLost && host.online),
      history: shell.feed.history[host.id] ?? null,
      services: serviceOptionsFor(host),
      prefs: cardPrefs(layout.cards, host.id),
      collapsed: cardCollapsed(layout.cards, host.id),
      panes: panesByHost.get(host.id) ?? [],
    })),
  );

  // --- navigation -----------------------------------------------------------
  // Secondary navigation lives in the profile menu; product pages provide their own
  // return action and adding a host already has a tile below the cards.
  const onDashboard = $derived(page.url.pathname === "/");

  // --- narrow screens: one region at a time ---------------------------------
  // Three regions side by side need about 1000px. Below that they were stacked and the
  // terminals measured 0px tall, so a phone shows one region and the tab bar chooses.
  // A route other than `/` has no terminal or dock region to compete with, so its own
  // panel IS the view — deriving it means `data-view` can never name a region the
  // current route did not render.
  const view = $derived(onDashboard ? shell.view : "page");
  /**
   * Language, theme and profile sit in the dashboard's toolbar, beside the file explorer
   * toggle (0.17.21: the column is for hosts). Where there is no such toolbar — any route
   * but `/`, and a narrow screen whose toolbar is compact — they stay at the top of the
   * column, so they are never out of reach. Same breakpoint as the dashboard page.
   */
  const stacked = new MediaQuery(`max-width: ${SHELL_STACK_MAX_WIDTH - 1}px`, untrack(() => data.phoneHint));
  const toolsInToolbar = $derived(onDashboard && !stacked.current);
  const tabs = $derived([
    { id: "hosts", label: i18n.t.dash.tabs.hosts, iconKind: "servers" as const },
    { id: "terminal", label: i18n.t.dash.tabs.terminal, iconKind: "terminal" as const },
    { id: "git", label: i18n.t.dash.tabs.git, iconKind: "git" as const },
    { id: "files", label: i18n.t.dash.tabs.files, iconKind: "files" as const },
  ]);

  /**
   * A Back press restores a history entry; this is the half of the loop that turns that into
   * a visible tab change.
   *
   * ⚠ `untrack` around the write. The helper compares against `shell.view` before setting
   * it, so without this the effect would depend on the very state it mutates — Svelte
   * reported `effect_update_depth_exceeded` and the whole shell stopped updating (a tab tap
   * did nothing at all). The tracked input is the history entry, and only that.
   */
  $effect(() => {
    const entry = page.state;
    // invalidateAll may replace shallow page state during a settings save. Keep
    // the background region and restore its history value when the modal closes.
    if (settingsDialog.open) return;
    untrack(() => syncViewFromHistory(shell, entry));
  });

  /**
   * The software keyboard. `dvh` does not account for it on either engine (iOS leaves the
   * layout viewport alone; Android resizes only the visual viewport by default), so a shell
   * sized in `dvh` keeps the terminal's last rows and the key row underneath the keyboard.
   */
  const keyboard = trackVisualViewport();

  /** A terminal number on a card: go to the dashboard, the terminals, and that cell. */
  async function openPane(index: number): Promise<void> {
    if (!onDashboard) await goto("/");
    // Only a narrow screen has regions to switch; on a desktop the terminals are already there.
    if (stacked.current) selectView(shell, "terminal");
    shell.revealPane(index);
  }

  async function chooseView(id: string): Promise<void> {
    // The tab bar is only rendered on a narrow screen, where a non-dashboard route
    // occupies the whole shell — so choosing a region has to come home first.
    if (!onDashboard) await goto("/");
    selectView(shell, id as ShellView);
  }

  // --- card settings popover ------------------------------------------------
  // It belongs to the sidebar, so it lives here: the ⚙ that opens it is on a card.
  let settings = $state<{ hostId: string; anchor: { x: number; y: number } } | null>(null);
  const settingsHost = $derived(shell.feed.hosts.find((host) => host.id === settings?.hostId) ?? null);

  function openSettings(hostId: string, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    settings = { hostId, anchor: { x: rect.left, y: rect.bottom } };
  }

  dismissOnOutside(
    () => settings !== null,
    () => (settings = null),
  );

  // --- agent update popover -------------------------------------------------
  // Same seam as the ⚙ above: the card emits (hostId, anchor) and the app owns the
  // panel, because `@pdmux/ui` cannot import shadcn and must not learn to.
  let updating = $state<{ hostId: string; anchor: { x: number; y: number } } | null>(null);
  const updatingHost = $derived(shell.feed.hosts.find((host) => host.id === updating?.hostId) ?? null);

  function openUpdate(hostId: string, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    updating = { hostId, anchor: { x: rect.left, y: rect.bottom } };
  }

  dismissOnOutside(
    () => updating !== null,
    () => (updating = null),
  );

  async function runUpdate(host: HostView): Promise<void> {
    try {
      // ⚠ PIN THE VERSION THE POPOVER SHOWED. Omitting it lets the server resolve the
      // latest at the moment the request lands, so a release published between opening
      // the confirmation and pressing it deploys a binary nobody agreed to — a
      // confirmation that does not bind what it confirms. `/hosts` already pins.
      await agentUpdateApi.host(host.id, { version: host.latestAgentVersion });
      updating = null;
      // The same GET /hosts the sidebar already reads carries every phase after this,
      // so there is nothing to poll separately.
      await shell.feed.refresh();
    } catch (error) {
      toast.error(agentUpdateMessage(error, i18n.t));
    }
  }

  // --- adding and removing a host, in the column itself ---------------------
  /**
   * The fleet column IS the fleet, so what you do to a fleet happens here.
   *
   * Both halves used to happen somewhere else. "Add" was a link to `/hosts`, which
   * answered "add a machine" by taking the operator off the dashboard; and "remove"
   * had no affordance at all — the only delete lived in the host list's row menu, a
   * navigation and three clicks away from the card you were looking at when you
   * decided the machine was gone. Neither dialog needs a page: they are mounted by
   * the shell, so the layout behind them is exactly where it was when they close.
   */
  let addOpen = $state(false);


  /**
   * The one line under the host's name in the ⚙ panel.
   *
   * Built from the card's own reach vocabulary rather than new copy: the glyph beside
   * the name already says online/stopped/unknown, and a panel that disagreed with the
   * dot two pixels above it would be worse than no line at all.
   */
  const settingsStatus = $derived.by(() => {
    if (!settingsHost) return "";
    const reach = !settingsHost.enabled
      ? i18n.t.pdmux.host.stopped
      : settingsHost.online && !serverLost
        ? i18n.t.pdmux.host.online
        : i18n.t.pdmux.host.unknown;
    const seen = settingsHost.lastSeenAt
      ? formatDateTime(settingsHost.lastSeenAt)
      : i18n.t.dash.details.never;
    return `${reach} · ${seen}`;
  });

  const widgetLabels = $derived({
    agents: i18n.t.dash.widgets.agents,
    resources: i18n.t.dash.widgets.resources,
    links: i18n.t.dash.widgets.links,
  });

  // --- sidebar splitter -----------------------------------------------------
  // The handle reports a delta from where the gesture STARTED, so the width it is
  // applied to has to be the width the gesture started from — adding it to the current
  // width would compound every pointer move into a runaway column.
  let sidebarBase: number | null = null;

  function dragSidebar(delta: number, commit: boolean): void {
    sidebarBase ??= layout.sidebarWidth;
    const next = setSidebarWidth(layout, sidebarBase + delta);
    if (commit) sidebarBase = null;
    shell.apply(next);
  }

  onMount(() => shell.start());
  onDestroy(() => shell.stop());
</script>

<div
  class="flex h-dvh min-h-0 flex-col"
  style={keyboard.open ? `height:${keyboard.height}px` : undefined}
>
  {#if data.impersonating}
    <ImpersonationBanner email={data.user.email} />
  {/if}
  <!-- `main`, not a div: this shell IS the page's content, and the landmark is what lets
       a screen reader (and the shared "back to home" check) find it.
       Collapsing the sidebar is a dashboard choice; other pages keep the fleet visible. -->
  <main
  class="pdmux pdmux-shell min-h-0 flex-1"
  data-testid="dashboard-shell"
  data-sidebar={layout.sidebarOpen || !onDashboard ? "open" : "hidden"}
  data-dock={dockOpen ? "open" : "closed"}
  data-view={view}
  data-keyboard={keyboard.open ? "open" : "closed"}
  style="height:auto;--pdmux-left:{layout.sidebarWidth}px;--pdmux-right:{layout.dockWidth}px"
>
  <HostSidebar
    {cards}
    now={nowSeconds}
    windowSec={shell.feed.windowSec}
    connection={shell.feed.connection.state}
    {windowLabels}
    {t}
    onOpenService={(url: string) => window.open(url, "_blank", "noopener")}
    onOpenSettings={openSettings}
    onToggleCollapse={(hostId: string) => shell.toggleCollapsed(hostId)}
  onUpdateAgent={data.canManage ? openUpdate : undefined}
    onAddHost={data.canManage ? () => (addOpen = true) : undefined}
    onMove={(from: number, to: number) => shell.moveCard(from, to)}
    onOpenPane={(index: number) => openPane(index)}
    header={toolsInToolbar ? undefined : sidebarTools}
  />

  <SplitHandle {t} onDrag={(delta) => dragSidebar(delta, false)} onCommit={(delta) => dragSidebar(delta, true)} />

  {@render children()}

  <!-- Last in DOM order and pinned to row 2 by CSS, so what a route renders cannot
       displace it. Hidden entirely at desktop widths. -->
  <ShellViewTabs {tabs} active={onDashboard ? shell.view : null} {t} onSelect={chooseView} />
  </main>
</div>

<!-- Preferences and profile; return navigation belongs to each page. -->
{#snippet sidebarTools()}
  <div class="flex items-center gap-1" data-testid="shell-toolbar">
    <div class="ms-auto flex items-center gap-0.5">
      <LanguageSwitch />
      <ThemeToggle />
      <ShellUserMenu user={data.user} canManage={data.canManage} desktopStatus={data.desktopStatus} />
    </div>
  </div>
{/snippet}

<SettingsDialog data={data} />
<SessionManagerDialog bind:open={shell.sessionsOpen} onChanged={(renamed) => { if (renamed) { const next = renameSlotSessions(shell.layout, renamed.hostId, renamed, renamed.name); if (next !== shell.layout) shell.apply(next); } return shell.feed.refresh(); }} />

<!-- The card's own way out of the fleet. Declared here and handed to the popover as a
     value, so a member is passed nothing at all rather than an empty section.

     The separator and the padding around it used to be here too (`border-t mt-1 pt-2`),
     which made this snippet responsible for matching the rhythm of a panel it cannot
     see. That is the package's job and it now does it, so what is left is the one thing
     only the app can supply: the button, its wording, and the gate behind it. -->
{#snippet removeAction()}
  <!--
    One way out, and it is a link.

    ⚠ THERE WERE SIX BUTTONS HERE. Two of them (install command, update agent) were
    the same testid as buttons already on the host page; the other three (edit,
    disable, delete) existed ONLY here, so the page named after the host could not
    change it. They now live in that page's danger zone, which is where an
    irreversible action belongs — a 260px panel beside a card is not a place to be
    offered "delete this host" one row under a display switch.
  -->
  <Button
    href={`/hosts/${settingsHost?.id ?? ""}`}
    variant="outline"
    class="w-full"
    data-testid="host-manage"
    onclick={() => (settings = null)}
  >
    {i18n.t.dash.hosts.manage}
  </Button>
{/snippet}

{#if settings && settingsHost}
  <CardSettingsPopover
    hostName={settingsHost.label}
    prefs={cardPrefs(layout.cards, settingsHost.id)}
    status={settingsStatus}
    anchor={settings.anchor}
    labels={widgetLabels}
    {t}
    actions={data.canManage ? removeAction : undefined}
    onToggle={(widget: CardWidget) => settingsHost && shell.toggleWidget(settingsHost.id, widget)}
    onClose={() => (settings = null)}
  />
{/if}

{#if updating && updatingHost}
  <!--
    ⚠ `onclick`, NOT `onclickcapture`. `dismissOnOutside` listens on the document, so
    the panel has to stop its own clicks from reaching it — but stopping them in the
    CAPTURE phase stops them before they reach the button inside, and the button then
    does nothing at all. Measured: the popover opened, showed the right version, and
    the confirm button was inert. Bubble phase lets the target handle it first and
    stops it on the way out, which is what was wanted.
  -->
  <div
    class="bg-popover text-popover-foreground fixed z-50 w-72 space-y-3 rounded-md border p-3 shadow-md"
    style={`left:${Math.min(updating.anchor.x, (typeof window === "undefined" ? 1024 : window.innerWidth) - 300)}px;top:${updating.anchor.y + 4}px`}
    data-testid="agent-update-popover"
    role="dialog"
    tabindex="-1"
    aria-label={fmt(i18n.t.dash.agent.updateTitle, { label: updatingHost.label })}
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      if (event.key === "Escape") updating = null;
    }}
  >
    <p class="text-sm font-medium">{updatingHost.label}</p>
    <AgentUpdateConfirm host={updatingHost} slots={paneSlots(shell.layout.slots)} onCancel={() => (updating = null)} onConfirm={runUpdate} />
  </div>
{/if}

<!-- Mounted by the shell, so adding and removing never move the screen underneath.
     The same form the host list uses (there is one add path), and the same typing
     gate its row menu uses: deleting a host is irreversible and takes the tokens with
     it, so proving you are looking at the card you think you are is the whole point. -->
<HostFormDialog bind:open={addOpen} />

<VmPowerConfirm power={vmPower} panesOn={(hostId: string) => shell.layout.slots.filter((slot) => slot?.hostId === hostId).length} />
<Toaster
  offset={settingsDialog.open ? { bottom: "calc(max(1rem, (100dvh - 52rem) / 2) + 5rem)" } : undefined}
  mobileOffset={settingsDialog.open ? { bottom: "6rem" } : undefined}
/>
