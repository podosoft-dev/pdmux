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
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { CardSettingsPopover, HostSidebar, ShellViewTabs, SplitHandle } from "@pdmux/ui";
  import {
    type CardWidget,
    cardCollapsed,
    cardPrefs,
    freshMetrics,
    setSidebarWidth,
  } from "@pdmux/core";
  import LanguageSwitch from "$lib/components/language-switch.svelte";
  import ThemeToggle from "$lib/components/theme-toggle.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ServerIcon from "@lucide/svelte/icons/server";
  import SlidersIcon from "@lucide/svelte/icons/sliders-horizontal";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Toaster } from "$lib/components/ui/sonner";
  import { fmt, formatDateTime, getI18n } from "$lib/i18n";
  import HostFormDialog from "$lib/dashboard/components/host-form-dialog.svelte";
  import ShellUserMenu from "$lib/dashboard/components/shell-user-menu.svelte";
  import { dismissOnOutside } from "$lib/dashboard/popover-dismiss.svelte";
  import { selectView, syncViewFromHistory } from "$lib/dashboard/mobile-view.svelte";
  import { trackVisualViewport } from "$lib/dashboard/visual-viewport.svelte";
  import { type ShellView, provideShellState } from "$lib/dashboard/shell-state.svelte";
  import {
    agentRowsFor,
    hostResources,
    hostSummary,
    metricsFeed,
    serviceOptionsFor,
  } from "$lib/dashboard/map";
  import { cardUpdate, paneSlots } from "$lib/dashboard/agent-update";
  import { agentUpdateApi } from "$lib/dashboard/api";
  import { agentUpdateMessage } from "$lib/dashboard/wording";
  import AgentUpdateConfirm from "$lib/dashboard/components/agent-update-confirm.svelte";
  import type { HostUpdateMark } from "@pdmux/ui";
  import { uiTranslate } from "$lib/dashboard/ui-i18n";
  import type { HostView } from "$lib/dashboard/types";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: import("svelte").Snippet } = $props();

  const i18n = getI18n();
  const t = $derived(uiTranslate(i18n.t));

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
      relayMessages: {
        reconnecting: i18n.t.dash.terminal.reconnecting,
        restored: i18n.t.dash.terminal.detached,
        dropped: (bytes: number) => i18n.t.dash.terminal.dropped.replace("{count}", String(bytes)),
      },
    }),
  );

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

  const cards = $derived(
    shell.feed.hosts.map((host) => ({
      host: hostSummary(host, updateMark(host)),
      agents: agentRowsFor(host, shell.providers, shell.feed.now),
      resources: hostResources(host, freshById.get(host.id)),
      history: shell.feed.history[host.id] ?? null,
      services: serviceOptionsFor(host),
      prefs: cardPrefs(layout.cards, host.id),
      collapsed: cardCollapsed(layout.cards, host.id),
    })),
  );

  // --- navigation -----------------------------------------------------------
  // The sidebar carries the shell's own navigation, so "how do I get back to the
  // dashboard" has one persistent answer on every page in the group. Host management
  // is administrator-only on the API, so a link to it for anyone else would lead to a
  // page of buttons that all answer 403.
  const onHosts = $derived(page.url.pathname.startsWith("/hosts"));
  const onDashboard = $derived(page.url.pathname === "/");
  // `/settings` is the FLEET's settings, not the installation's — those are `/admin/*`
  // and live outside this shell entirely, so there is no prefix to disambiguate here.
  const onSettings = $derived(page.url.pathname.startsWith("/settings"));
  const onAccess = $derived(page.url.pathname.startsWith("/access"));

  // --- narrow screens: one region at a time ---------------------------------
  // Three regions side by side need about 1000px. Below that they were stacked and the
  // terminals measured 0px tall, so a phone shows one region and the tab bar chooses.
  // A route other than `/` has no terminal or dock region to compete with, so its own
  // panel IS the view — deriving it means `data-view` can never name a region the
  // current route did not render.
  const view = $derived(onDashboard ? shell.view : "page");
  const tabs = $derived([
    { id: "hosts", label: i18n.t.dash.tabs.hosts, icon: "▤" },
    { id: "terminal", label: i18n.t.dash.tabs.terminal, icon: "▮" },
    { id: "git", label: i18n.t.dash.tabs.git, icon: "⑂" },
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
    untrack(() => syncViewFromHistory(shell, entry));
  });

  /**
   * The software keyboard. `dvh` does not account for it on either engine (iOS leaves the
   * layout viewport alone; Android resizes only the visual viewport by default), so a shell
   * sized in `dvh` keeps the terminal's last rows and the key row underneath the keyboard.
   */
  const keyboard = trackVisualViewport();

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
      : settingsHost.online
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

<!-- `main`, not a div: this shell IS the page's content, and the landmark is what lets
     a screen reader (and the shared "back to home" check) find it. -->
<main
  class="pdmux pdmux-shell"
  data-testid="dashboard-shell"
  data-sidebar={layout.sidebarOpen ? "open" : "hidden"}
  data-dock={dockOpen ? "open" : "closed"}
  data-view={view}
  data-keyboard={keyboard.open ? "open" : "closed"}
  style="--pdmux-left:{layout.sidebarWidth}px;--pdmux-right:{layout.dockWidth}px;{keyboard.open
    ? `--pdmux-vh:${keyboard.height}px`
    : ''}"
>
  <HostSidebar
    {cards}
    now={nowSeconds}
    windowSec={shell.feed.windowSec}
    {windowLabels}
    {t}
    onOpenService={(url: string) => window.open(url, "_blank", "noopener")}
    onOpenSettings={openSettings}
    onToggleCollapse={(hostId: string) => shell.toggleCollapsed(hostId)}
  onUpdateAgent={data.canManage ? openUpdate : undefined}
    onAddHost={data.canManage ? () => (addOpen = true) : undefined}
  >
    {#snippet header()}
      <!--
        ONE ROW, and the wordmark is what paid for it.

        The column exists to hold cards; every pixel above the first one is overhead. The
        controls had a row to themselves purely because "pdmux" occupied the row above —
        and the product name is the one thing on this screen nobody needs telling, since
        they are looking at it. Dropping it puts the controls where it was and gives the
        height back to the fleet.

        Two controls, and the difference between them is the point: ADD acts here, MANAGE
        goes somewhere. The plus used to be the link — adding a machine began by leaving
        the dashboard, and the operator arrived on a table to press a second Add. Now it
        opens the same dialog that table opens, over the cards, and the new card appears
        in this column. The link stays because host management is still a real screen
        (services, tokens, per-host detail), and this row is now the ONLY way to it: the
        terminal toolbar carried a second "Hosts" button in its top-right corner, saying
        the same thing in the same window, and two doors to one screen is one too many.
        The sidebar keeps it because the sidebar is where the fleet already is — and it
        is the only one of the two a phone ever showed.

        Icons rather than labels: the words were the widest thing in a column whose whole
        job is to be narrow, and both already carried `title`/`aria-label`, so dropping the
        text costs nothing a pointer or a screen reader can tell.

        Administrators only: a member cannot change the fleet, and controls that lead to
        403 are worse than none. The language, theme and account controls use `ms-auto`
        rather than `justify-between` so they stay at the end for a member too, with
        nothing on the left to space against.

        THE ACCOUNT AVATAR IS HERE, not in the footer slot it used to occupy. A name and
        an address pinned to the bottom of the column spent ~52px permanently on a fact
        that is asked for once a session, in the one place on the screen whose whole job
        is to fit host cards. The identity moved into the menu; the avatar joins a row
        that already existed, so what used to cost a band of the column now costs nothing.
      -->
      <div class="flex items-center gap-1">
        {#if data.canManage}
          <Button
            variant="ghost"
            size="sm"
            class="text-muted-foreground hover:text-foreground size-7 w-fit px-1.5 text-xs"
            title={i18n.t.dash.hosts.add}
            aria-label={i18n.t.dash.hosts.add}
            data-testid="host-add-sidebar"
            onclick={() => (addOpen = true)}
          >
            <PlusIcon class="size-3.5" aria-hidden="true" />
          </Button>
          <!-- A `Button` with an `href`, not a bare `<a>`: it sits in the same row as ADD,
               which is a button. Hand-styled, it rendered 22px tall beside a 28px sibling
               and answered hover with an outline where every other control in the shell
               answers with a fill. `aria-current` still drives the active look — that
               variant is the one thing the primitive has no opinion on. -->
          <Button
            href="/hosts"
            variant="ghost"
            size="sm"
            class="text-muted-foreground hover:text-foreground size-7 w-fit px-1.5 text-xs aria-[current=page]:text-foreground aria-[current=page]:bg-accent"
            title={i18n.t.dash.hostsLink}
            aria-label={i18n.t.dash.hostsLink}
            data-testid="nav-hosts"
            aria-current={onHosts ? "page" : undefined}
          >
            <ServerIcon class="size-3.5" aria-hidden="true" />
          </Button>
          <!-- The fleet's settings, beside the fleet. Same `Button href=` as its
               neighbour for the same reason (a hand-styled `<a>` renders short and
               answers hover differently), and gated by the same `canManage`: the API
               refuses `PUT /fleet/settings` without it, so a member offered the door
               would arrive at a form whose only button is a 403. -->
          <Button
            href="/settings"
            variant="ghost"
            size="sm"
            class="text-muted-foreground hover:text-foreground size-7 w-fit px-1.5 text-xs aria-[current=page]:text-foreground aria-[current=page]:bg-accent"
            title={i18n.t.dash.fleet.title}
            aria-label={i18n.t.dash.fleet.title}
            data-testid="nav-settings"
            aria-current={onSettings ? "page" : undefined}
          >
            <SlidersIcon class="size-3.5" aria-hidden="true" />
          </Button>
        {/if}
        <!-- Not gated on `canManage`: a read-only token is exactly what a member who
             cannot change anything still wants, so the door has to be open to them. -->
        <Button
          href="/access"
          variant="ghost"
          size="sm"
          class="text-muted-foreground hover:text-foreground size-7 w-fit px-1.5 text-xs aria-[current=page]:text-foreground aria-[current=page]:bg-accent"
          title={i18n.t.dash.mcpTokens.title}
          aria-label={i18n.t.dash.mcpTokens.title}
          data-testid="nav-access"
          aria-current={onAccess ? "page" : undefined}
        >
          <KeyRoundIcon class="size-3.5" aria-hidden="true" />
        </Button>
        <div class="ms-auto flex items-center gap-0.5">
          <LanguageSwitch />
          <ThemeToggle />
          <ShellUserMenu user={data.user} />
        </div>
      </div>
    {/snippet}
  </HostSidebar>

  <SplitHandle {t} onDrag={(delta) => dragSidebar(delta, false)} onCommit={(delta) => dragSidebar(delta, true)} />

  {@render children()}

  <!-- Last in DOM order and pinned to row 2 by CSS, so what a route renders cannot
       displace it. Hidden entirely at desktop widths. -->
  <ShellViewTabs {tabs} active={onDashboard ? shell.view : null} {t} onSelect={chooseView} />
</main>

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

<Toaster />
