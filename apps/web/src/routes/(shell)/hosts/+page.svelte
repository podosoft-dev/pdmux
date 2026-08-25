<script lang="ts">
  /**
   * The host list: add, edit, enable, reorder, delete — rendered in the shell's right-
   * hand area, beside the same cards the dashboard shows.
   *
   * The point of this screen (ARCHITECTURE §6): the fleet is data in the product, not
   * a constant in a script. The previous tool kept its machine list in a tunnel script,
   * so "add a machine" meant editing source and redeploying.
   *
   * IT READS THE SHELL'S FEED, not a list of its own. Two copies of the fleet on one
   * screen is a bug waiting to happen — the table would show a host the cards beside it
   * do not — and refreshing the shared feed after a mutation updates both at once.
   *
   * Reordering sends the WHOLE order rather than the moved pair — that makes the call
   * idempotent, so a dropped click leaves the list consistent instead of shuffled.
   */
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable, { type DataTableColumn, type SortState } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarFilter, type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { toast } from "svelte-sonner";
  import { fmt, formatDateTime, getI18n } from "#lib/i18n/index.js";
  import { agentUpdateApi, errorCode, hostsApi } from "#lib/dashboard/api.js";
  import {
    failureCodes,
    offersUpdate,
    paneSlots,
    selectAllState,
    updateInFlight,
  } from "#lib/dashboard/agent-update.js";
  import AgentUpdateDialog from "#lib/dashboard/components/agent-update-dialog.svelte";
  import AgentVersionCell from "#lib/dashboard/components/agent-version-cell.svelte";
  import BulkUpdateDialog from "#lib/dashboard/components/bulk-update-dialog.svelte";
  import ConfirmDialog from "#lib/dashboard/components/confirm-dialog.svelte";
  import HostFormDialog from "#lib/dashboard/components/host-form-dialog.svelte";
  import HostInstallDialog from "#lib/dashboard/components/host-install-dialog.svelte";
  import ShellBreadcrumb from "#lib/dashboard/components/shell-breadcrumb.svelte";
  import { hostAddress, hostState } from "#lib/dashboard/map.js";
  import { useShellState } from "#lib/dashboard/shell-state.svelte.ts";
  import { causeMessage, codeMessage, agentUpdateMessage } from "#lib/dashboard/wording.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  const shell = useShellState();

  let sort = $state<SortState | null>(null);
  let page = $state(1);
  let search = $state("");
  let searchField = $state("label");
  let filterValues = $state<Record<string, string>>({ state: "", seen: "" });
  let applied = $state({ search: "", state: "", seen: "" });

  /**
   * "Never connected" is a THIRD state, and only this column can tell it.
   *
   * ⚠ `hostState()` in `map.ts` collapses a host that has never reported into
   * `offline` — the same word as one that died five minutes ago. That is left
   * exactly as it is: the cards are built on its three-value contract, and
   * widening it there would change what every card paints. The distinction is
   * made HERE, on the list, because `lastSeenAt` is the only signal that carries
   * it and this screen is the only one that shows the column.
   */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RECENT_DAYS = 7;
  const STALE_DAYS = 30;

  type SeenBucket = "never" | "recent" | "stale" | "between";

  function seenBucket(lastSeenAt: string | null, now: number): SeenBucket {
    if (lastSeenAt === null) return "never";
    const days = (now - Date.parse(lastSeenAt)) / DAY_MS;
    // An unparsable timestamp is not a claim we can make about the machine, so it
    // falls in the bucket that no filter selects rather than being called "never".
    if (!Number.isFinite(days)) return "between";
    if (days <= RECENT_DAYS) return "recent";
    if (days >= STALE_DAYS) return "stale";
    return "between";
  }

  /**
   * How much notice the list gives before the server's sweep takes a host.
   *
   * A warning that appears in the hour before the reaper is not a warning — this
   * is the whole reason the column says anything at all (Tailscale shows last-seen
   * and lets you filter on it rather than deleting quietly). Seven days, or the
   * entire window when the operator chose a shorter one.
   */
  const REMOVAL_WARN_DAYS = 7;

  type RemovalNote = { kind: "due" } | { kind: "soon"; days: number };

  function removalNote(lastSeenAt: string | null, retentionDays: number, now: number): RemovalNote | null {
    // 0 is the off switch, and a host that never connected is never swept — the
    // server's `lastSeenAt < cutoff` cannot match a row that has no `lastSeenAt`.
    // Neither case gets a warning, because neither is going anywhere.
    if (retentionDays <= 0 || lastSeenAt === null) return null;
    const days = (now - Date.parse(lastSeenAt)) / DAY_MS;
    if (!Number.isFinite(days)) return null;
    const left = retentionDays - days;
    if (left <= 0) return { kind: "due" };
    if (left > Math.min(REMOVAL_WARN_DAYS, retentionDays)) return null;
    return { kind: "soon", days: Math.max(1, Math.ceil(left)) };
  }

  /** `0` when the fleet never opted in — and when the loader could not ask. */
  const staleRetentionDays = $derived(data.fleet.staleHostRetentionDays ?? 0);

  const crumbs = $derived([
    { label: i18n.t.dash.title, href: "/", testId: "open-dashboard" },
    { label: i18n.t.dash.hosts.title },
  ]);

  const filters = $derived<ToolbarFilter[]>([
    {
      key: "state",
      label: i18n.t.dash.hosts.filterState,
      options: [
        { value: "", label: i18n.t.dash.hosts.filterAll },
        { value: "online", label: i18n.t.dash.hosts.online },
        { value: "offline", label: i18n.t.dash.hosts.offline },
        { value: "disabled", label: i18n.t.dash.hosts.disabled },
      ],
    },
    // The second filter on the same toolbar, not a parallel one: both commit
    // together on the Search button, so narrowing by state AND by silence is one
    // pass rather than two guesses.
    {
      key: "seen",
      label: i18n.t.dash.hosts.filterSeen,
      options: [
        { value: "", label: i18n.t.dash.hosts.filterAll },
        { value: "recent", label: i18n.t.dash.hosts.seenRecent },
        { value: "stale", label: i18n.t.dash.hosts.seenStale },
        // The one this screen was missing: a row that has never connected is
        // invisible among the offline ones until you can ask for it.
        { value: "never", label: i18n.t.dash.hosts.neverConnected },
      ],
    },
  ]);
  const searchFields = $derived<ToolbarSearchField[]>([{ value: "label", label: i18n.t.dash.hosts.label }]);

  const rows = $derived(
    shell.feed.hosts.filter((host) => {
      const state = host.enabled ? (host.online ? "online" : "offline") : "disabled";
      if (applied.state && state !== applied.state) return false;
      if (applied.seen && seenBucket(host.lastSeenAt, Date.now()) !== applied.seen) return false;
      if (!applied.search) return true;
      const needle = applied.search.toLowerCase();
      // The DISPLAYED address, so a search cannot match on something no row shows.
      // `127` would otherwise select the whole fleet on a value none of them print.
      return `${host.label} ${hostAddress(host) ?? ""}`.toLowerCase().includes(needle);
    }),
  );

  /**
   * Seven columns measured 611px wide inside a 390px screen. The shadcn table scrolls
   * sideways, so nothing was clipped — but reaching the row menu meant scrolling past four
   * columns first. Name, state and the menu are what a phone needs; the rest come back at
   * the same 900px the shell stops stacking at (`max-[899px]:hidden`, not Tailwind's `md`,
   * so there is ONE breakpoint in this product rather than two that nearly agree).
   */
  const NARROW_HIDDEN = "max-[899px]:hidden";
  const columns = $derived<DataTableColumn<HostView>[]>([
    // Hidden at the same 900px the rest of the fleet columns are: a batch rollout
    // is not a phone gesture, and a fourth column there costs the row menu its place.
    //
    // `head` puts SELECT-ALL in the header cell, where a table's select-all belongs and
    // where it explains the column under it. It needed an extension to `DataTable`,
    // which is PodoKit output: one additive branch, so a column without a `head` renders
    // exactly as before. The alternative was leaving it in a bar that had to be on
    // screen permanently to be discoverable — a control that is always there for a
    // selection that usually is not.
    ...(data.canManage
      ? [{ key: "select", label: i18n.t.dash.agent.selectAll, head: selectAllHead, class: `w-8 ${NARROW_HIDDEN}` }]
      : []),
    { key: "label", label: i18n.t.dash.hosts.label, sortable: true },
    { key: "address", label: i18n.t.dash.hosts.address, sortable: true, class: NARROW_HIDDEN },
    { key: "state", label: i18n.t.dash.hosts.state, value: (host) => hostState(host) },
    {
      key: "agentVersion",
      label: i18n.t.dash.hosts.agentVersion,
      sortable: true,
      class: NARROW_HIDDEN,
      // Sorted by the VERDICT, not the number: grouping every outdated host
      // together is the thing a fleet operator is looking for, and `0.9.0` vs
      // `0.10.0` sorts as text in a way nobody means.
      value: (host) => host.agentVersionState,
    },
    {
      key: "services",
      label: i18n.t.dash.hosts.services,
      value: (host) => host.services.length,
      class: NARROW_HIDDEN,
    },
    { key: "lastSeenAt", label: i18n.t.dash.hosts.lastSeen, sortable: true, class: NARROW_HIDDEN },
    { key: "actions", label: "" },
  ]);

  function applySearch(): void {
    applied = { search: search.trim(), state: filterValues.state ?? "", seen: filterValues.seen ?? "" };
    page = 1;
  }

  /** Pull the fleet again so the table AND the cards beside it show the change. */
  async function reload(): Promise<void> {
    await shell.feed.refresh();
    // The feed keeps the last good list on screen and records the code instead of
    // throwing, so a failure has to be read back rather than caught.
    if (shell.feed.error) toast.error(codeMessage(shell.feed.error, i18n.t));
  }

  const message = (cause: unknown): string => causeMessage(cause, i18n.t);

  // --- create / edit --------------------------------------------------------
  // The form itself, the `create` call and the install command it hands over live in
  // `host-form-dialog.svelte`, which the sidebar mounts too: "add a host" has to mean
  // the same thing (and end on the same one-line installer) wherever it is pressed.
  let formOpen = $state(false);
  let editing = $state<HostView | null>(null);

  function openCreate(): void {
    editing = null;
    formOpen = true;
  }

  function openEdit(host: HostView): void {
    editing = host;
    formOpen = true;
  }

  // --- install (enrollment code) -------------------------------------------
  // The ROW MENU's copy: an existing host, so there is no fresh code to hand over and
  // the dialog mints one for itself. Creation's copy belongs to the form dialog, which
  // passes on the code `POST /hosts` already returned.
  let installOpen = $state(false);
  let installHostId = $state<string | null>(null);
  let installLabel = $state("");
  /** The LIVE row, so the dialog's status line moves with the shell's own poll. */
  const installHost = $derived(shell.feed.hosts.find((host) => host.id === installHostId) ?? null);

  function openInstall(hostId: string, label: string): void {
    installHostId = hostId;
    installLabel = label;
    installOpen = true;
  }

  // --- agent update ---------------------------------------------------------
  /** Panes this browser has open, so the confirmation can count what it costs. */
  const openPanes = $derived(paneSlots(shell.layout.slots));

  let updateOpen = $state(false);
  let updating = $state<HostView | null>(null);

  function askUpdate(host: HostView): void {
    updating = host;
    updateOpen = true;
  }

  /** Update failures name the host's own condition; the map lives in `wording.ts`. */
  const updateMessage = (cause: unknown): string => agentUpdateMessage(cause, i18n.t);

  async function runUpdate(host: HostView): Promise<void> {
    try {
      await agentUpdateApi.host(host.id, { version: host.latestAgentVersion });
      await reload();
    } catch (cause: unknown) {
      toast.error(updateMessage(cause));
    }
  }

  // --- selection ------------------------------------------------------------
  /**
   * Selection is GENERAL, not "selected for update".
   *
   * ⚠ IT USED TO BE THE OTHER WAY AND IT READ AS A BROKEN TABLE. The tick-box was
   * disabled unless the host could be updated, so a fleet that is entirely up to date
   * — the normal state — showed a column of controls that never click, under a blank
   * header, with nothing on screen to say why. It was reported as exactly that.
   *
   * So every row ticks, and each ACTION decides what it can do with the selection and
   * says so in its own dialog. The rule that mattered is not lost: a batch still
   * refuses to guess at a host whose version it cannot read, it just refuses out loud
   * (`updateSkip`) instead of through a control that will not move.
   */
  let selectedIds = $state<string[]>([]);
  /** Selection follows the fleet: a row that leaves the table leaves the selection with it. */
  const selected = $derived(rows.filter((host) => selectedIds.includes(host.id)));
  const allBox = $derived(selectAllState(rows, selectedIds));
  let bulkBusy = $state(false);

  function toggleSelected(host: HostView, on: boolean): void {
    selectedIds = on ? [...new Set([...selectedIds, host.id])] : selectedIds.filter((id) => id !== host.id);
  }

  /**
   * Select-all acts on the ROWS IN FRONT OF THE OPERATOR, not on the fleet.
   *
   * `rows` is what search and the filters left, so a narrowed table selects what it
   * shows. Selecting hosts that were filtered out would be a batch reaching machines
   * nobody meant to touch — the same failure the version rule exists to prevent, by a
   * different route.
   */
  function toggleAll(on: boolean): void {
    selectedIds = on ? rows.map((host) => host.id) : [];
  }

  // --- bulk update ----------------------------------------------------------
  let bulkUpdateOpen = $state(false);

  /**
   * Report the OUTCOME, not "it worked".
   *
   * The endpoint stops after two refusals, so a batch can end with hosts started,
   * hosts refused and hosts never attempted all at once. Grouping the failures by
   * code is the finding: the same code on several hosts says the release is bad,
   * one code per host says the hosts are.
   */
  async function runBulkUpdate(hosts: HostView[], version: string): Promise<void> {
    if (hosts.length === 0 || bulkBusy) return;
    bulkBusy = true;
    try {
      const outcome = await agentUpdateApi.fleet(
        hosts.map((host) => host.id),
        version,
      );
      if (outcome.failed.length > 0) {
        toast.error(
          fmt(i18n.t.dash.agent.bulkFailed, {
            count: outcome.failed.length,
            version: outcome.version,
            codes: failureCodes(outcome.failed),
          }),
        );
      }
      if (outcome.stopped) {
        toast.error(fmt(i18n.t.dash.agent.bulkStopped, { count: outcome.notAttempted.length }));
      }
      selectedIds = [];
      await reload();
    } catch (cause: unknown) {
      toast.error(updateMessage(cause));
    } finally {
      bulkBusy = false;
    }
  }

  // --- bulk delete ----------------------------------------------------------
  let bulkDeleteOpen = $state(false);

  /**
   * Delete the selection, ONE AT A TIME, and report what actually happened.
   *
   * SEQUENTIAL, NOT `Promise.all`. Deleting a host is not one row going away — the
   * server takes its services, tokens, enrollment code and collected history with it,
   * and firing a dozen of those cascades at once is load nobody asked for on a
   * database that is also serving somebody's live dashboard. Serial is also the only
   * order in which a partial result means anything.
   *
   * ⚠ A FAILURE DOES NOT STOP THE REST, and that is the deliberate half. The operator
   * asked for these hosts to go; one that refuses is a fact to report, not a reason
   * to leave the other ten in a state nobody chose. There is no server call that does
   * this as one unit, so the honest thing is to finish and say plainly how many did
   * not make it.
   */
  async function runBulkDelete(): Promise<void> {
    const doomed = selected;
    if (doomed.length === 0 || bulkBusy) return;
    bulkBusy = true;
    let removed = 0;
    const failed: string[] = [];
    try {
      for (const host of doomed) {
        try {
          await hostsApi.remove(host.id);
          removed += 1;
        } catch {
          failed.push(host.label);
        }
      }
      if (removed > 0) toast.success(fmt(i18n.t.dash.agent.bulkDeleted, { count: removed }));
      // Named, not counted: "3 could not be deleted" sends somebody hunting through
      // the table for which three.
      if (failed.length > 0) {
        toast.error(`${fmt(i18n.t.dash.agent.bulkDeleteFailed, { count: failed.length })}: ${failed.join(", ")}`);
      }
      selectedIds = [];
      await reload();
    } finally {
      bulkBusy = false;
    }
  }

  // --- enable / reorder / delete -------------------------------------------
  async function setEnabled(host: HostView, enabled: boolean): Promise<void> {
    try {
      await hostsApi.setEnabled(host.id, enabled);
      await reload();
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  async function move(host: HostView, delta: number): Promise<void> {
    const ordered = [...shell.feed.hosts].sort((a, b) => a.sortOrder - b.sortOrder);
    const from = ordered.findIndex((row) => row.id === host.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const moved = ordered[from];
    const target = ordered[to];
    if (!moved || !target) return;
    ordered[from] = target;
    ordered[to] = moved;
    try {
      await hostsApi.reorder(ordered.map((row) => row.id));
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
    await reload();
  }

  let deleteOpen = $state(false);
  let deleting = $state<HostView | null>(null);

  function askDelete(host: HostView): void {
    deleting = host;
    deleteOpen = true;
  }

  async function confirmDelete(): Promise<void> {
    const host = deleting;
    if (!host) return;
    try {
      // Through the shell, not `hostsApi` directly: it refreshes the fleet AND drops
      // any pane still pointed at the host, which is the half a screen cannot do for
      // itself. Same call the card's own Delete makes.
      await shell.removeHost(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }
</script>

<svelte:head><title>{i18n.t.dash.hosts.title} · pdmux</title></svelte:head>

<!-- The shell owns the viewport, so this column owns its own scrolling (ARCHITECTURE §7). -->
<div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-6" data-testid="hosts-panel" data-pdmux-region="page">
  <ShellBreadcrumb {crumbs} label={i18n.t.dash.breadcrumbLabel} />

  <div class="flex items-center justify-between gap-2">
    <div>
      <h1 class="text-2xl font-semibold">{i18n.t.dash.hosts.title}</h1>
      <p class="text-muted-foreground text-sm">{i18n.t.dash.hosts.subtitle}</p>
    </div>
    {#if data.canManage}
      <Button onclick={openCreate} data-testid="host-add">
        <PlusIcon class="size-4" />{i18n.t.dash.hosts.add}
      </Button>
    {/if}
  </div>

  <TableToolbar
    {filters}
    bind:filterValues
    {searchFields}
    bind:searchField
    bind:search
    filterHeading={i18n.t.toolbar.filter}
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={applySearch}
  />

  <!--
    The actions, and NOTHING when there is no selection.

    Select-all lives in the table's own header now, which is where a reader looks for it
    and what finally explains the column beneath it — so this bar no longer has to be
    permanently on screen to make the tick-boxes discoverable. It appears with the first
    tick and leaves with the last, which is the only state in which it has anything to
    say: a row reading "0 selected" beside two dead buttons is the same spent control
    this screen has now been cleared of twice.

    ⚠ HIDDEN AT THE SAME 900px THE COLUMN IS. A batch rollout is deliberately not a phone
    gesture and the tick-boxes go with the other fleet columns at that width; actions for
    a selection nobody can make would be worse than none.
  -->
  {#if data.canManage && selected.length > 0}
    <div class="flex flex-wrap items-center gap-3 rounded-md border p-3 {NARROW_HIDDEN}" data-testid="bulk-bar">
      <span class="text-sm font-medium" data-testid="bulk-count">
        {fmt(i18n.t.dash.agent.selected, { count: selected.length })}
      </span>
      <!-- Right of the bar, per the screen's own reading order: what you picked on the
           left, what you can do with it on the right. -->
      <div class="ms-auto flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={bulkBusy} onclick={() => (bulkUpdateOpen = true)} data-testid="bulk-update">
          {i18n.t.dash.agent.update}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={bulkBusy}
          onclick={() => (bulkDeleteOpen = true)}
          data-testid="bulk-delete"
        >
          {i18n.t.dash.agent.bulkDelete}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (selectedIds = [])} data-testid="bulk-clear">
          {i18n.t.dash.agent.bulkClear}
        </Button>
      </div>
    </div>
  {/if}

  <DataTable
    {columns}
    {rows}
    getKey={(host) => host.id}
    empty={i18n.t.dash.hosts.empty}
    bind:sort
    bind:page
    perPage={0}
    label={i18n.t.dash.hosts.title}
  >
    {#snippet row(host)}
      {#if data.canManage}
        <Table.Cell class="w-8 {NARROW_HIDDEN}">
          <!-- Never disabled. This box means "I picked this host", not "this host can
               be updated"; the second question belongs to whichever action is chosen,
               where it can be answered in words instead of by refusing to click. -->
          <Checkbox
            checked={selectedIds.includes(host.id)}
            aria-label={fmt(i18n.t.dash.agent.bulkSelectRow, { label: host.label })}
            onCheckedChange={(on: boolean) => toggleSelected(host, on)}
            data-testid={`host-select-${host.label}`}
          />
        </Table.Cell>
      {/if}
      <Table.Cell class="font-medium">
        <a class="hover:underline" href={`/hosts/${host.id}`} data-testid={`host-open-${host.label}`}>{host.label}</a>
      </Table.Cell>
      <!-- `hostAddress`, not the raw column: a loopback address is every machine's name
           for itself, so as a way of saying WHICH host this row is it reads as an answer
           while carrying nothing. -->
      <Table.Cell class="text-muted-foreground {NARROW_HIDDEN}">{hostAddress(host) ?? "—"}</Table.Cell>
      <Table.Cell>
        {#if !host.enabled}
          <Badge variant="secondary">{i18n.t.dash.hosts.disabled}</Badge>
        {:else if host.online}
          <Badge variant="outline" class="text-green-600 dark:text-green-400">{i18n.t.dash.hosts.online}</Badge>
        {:else}
          <Badge variant="destructive">{i18n.t.dash.hosts.offline}</Badge>
        {/if}
      </Table.Cell>
      <Table.Cell class="text-muted-foreground {NARROW_HIDDEN}"><AgentVersionCell {host} /></Table.Cell>
      <Table.Cell class="text-muted-foreground tabular-nums {NARROW_HIDDEN}">{host.services.length}</Table.Cell>
      <!--
        ⚠ THE WORD "never" USED TO BE THE WHOLE ANSWER HERE, in the same grey as a
        date. A host that has never connected reads as one that is merely offline —
        the installer may never have been run on that machine, and nothing on the
        screen said so. It gets a marker, and the filter above gets an option.

        When the sweep is armed, this column is also where the notice lives: the
        point of the feature is a warning BEFORE the reaper, not a row that quietly
        disappears between two visits.
      -->
      <Table.Cell class="text-muted-foreground {NARROW_HIDDEN}">
        {#if host.lastSeenAt === null}
          <Badge
            variant="outline"
            class="text-amber-600 dark:text-amber-400"
            data-testid={`host-never-${host.label}`}
          >
            {i18n.t.dash.hosts.neverConnected}
          </Badge>
        {:else}
          {@const note = removalNote(host.lastSeenAt, staleRetentionDays, Date.now())}
          <span class="flex flex-wrap items-center gap-1.5">
            <span>{formatDateTime(host.lastSeenAt)}</span>
            {#if note}
              <Badge
                variant={note.kind === "due" ? "destructive" : "outline"}
                class={note.kind === "due" ? "" : "text-amber-600 dark:text-amber-400"}
                data-testid={`host-removal-${host.label}`}
              >
                {note.kind === "due"
                  ? i18n.t.dash.hosts.removalDue
                  : fmt(i18n.t.dash.hosts.removalIn, { days: note.days })}
              </Badge>
            {/if}
          </span>
        {/if}
      </Table.Cell>
      <Table.Cell>
        {#if data.canManage}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="icon" data-testid={`host-menu-${host.label}`}>
                  <EllipsisIcon class="size-4" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onSelect={() => openInstall(host.id, host.label)} data-testid={`host-install-${host.label}`}>
                {i18n.t.dash.enroll.menu}
              </DropdownMenu.Item>
              <!-- `ahead` gets no update: that host is a developer on a local build
                   and "update" would silently downgrade them. -->
              {#if offersUpdate(host.agentVersionState)}
                <DropdownMenu.Item
                  disabled={updateInFlight(host.lastUpdate)}
                  onSelect={() => askUpdate(host)}
                  data-testid={`host-update-${host.label}`}
                >
                  {i18n.t.dash.agent.update}
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => openEdit(host)}>{i18n.t.dash.hosts.edit}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void setEnabled(host, !host.enabled)}>
                {host.enabled ? i18n.t.dash.hosts.disable : i18n.t.dash.hosts.enable}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void move(host, -1)}>{i18n.t.dash.hosts.moveUp}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void move(host, 1)}>{i18n.t.dash.hosts.moveDown}</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => askDelete(host)}>{i18n.t.dash.hosts.delete}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
      </Table.Cell>
    {/snippet}
  </DataTable>
</div>

<HostFormDialog bind:open={formOpen} host={editing} />

<HostInstallDialog bind:open={installOpen} host={installHost} fallbackLabel={installLabel} />

<AgentUpdateDialog bind:open={updateOpen} host={updating} slots={openPanes} onConfirm={runUpdate} />

<!-- `fleet` is the WHOLE feed, not `rows`: the canary may be a host a search has
     hidden, and counting only what is on screen would invent a refusal the server
     would not make. -->
<BulkUpdateDialog
  bind:open={bulkUpdateOpen}
  hosts={selected}
  fleet={shell.feed.hosts}
  slots={openPanes}
  onConfirm={runBulkUpdate}
/>

<!--
  The typing gate is the single delete's, adapted to a set. There the operator retypes
  the row's label, because the dashboard is a grid of rows that look alike and that is
  what proves they are looking at the one they think they are. For a batch the thing
  you can be wrong about is HOW MANY, so the count is what gets retyped — and the list
  above it is what makes that number checkable rather than a formality.
-->
<ConfirmDialog
  bind:open={bulkDeleteOpen}
  title={fmt(i18n.t.dash.agent.bulkDeleteTitle, { count: selected.length })}
  warning={fmt(i18n.t.dash.agent.bulkDeleteWarning, { count: selected.length })}
  label={String(selected.length)}
  confirmLabel={i18n.t.dash.agent.bulkDelete}
  testId="bulk-delete-confirm"
  details={bulkDeleteList}
  onConfirm={runBulkDelete}
/>

{#snippet selectAllHead()}
  <!-- The column's heading IS the control. `aria-label` carries the name the blank
       header cannot, and the partial state is what tells a reader mid-selection that
       the box below them is not simply empty. -->
  <Checkbox
    checked={allBox.checked}
    indeterminate={allBox.indeterminate}
    aria-label={i18n.t.dash.agent.selectAll}
    onCheckedChange={(on: boolean) => toggleAll(on)}
    data-testid="host-select-all"
  />
{/snippet}

{#snippet bulkDeleteList()}
  <ul class="space-y-0.5" data-testid="bulk-delete-list">
    {#each selected as host (host.id)}
      <li class="flex items-center justify-between gap-3">
        <span class="truncate font-medium">{host.label}</span>
        <span class="text-muted-foreground shrink-0">{hostAddress(host) ?? "—"}</span>
      </li>
    {/each}
  </ul>
{/snippet}

<ConfirmDialog
  bind:open={deleteOpen}
  title={i18n.t.dash.hosts.deleteTitle}
  warning={fmt(i18n.t.dash.hosts.deleteWarning, { label: deleting?.label ?? "" })}
  label={deleting?.label ?? ""}
  confirmLabel={i18n.t.dash.hosts.delete}
  testId="host-delete"
  onConfirm={confirmDelete}
/>
