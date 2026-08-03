<script lang="ts">
  /**
   * One host: the ports it exposes and the tokens its agent uses.
   *
   * THE TOKEN IS SHOWN ONCE. The server stores a hash, so there is no "show it
   * again" — the dialog therefore hands over the finished install command rather
   * than a bare secret to copy into a manual somewhere.
   *
   * It renders in the shell's right-hand area, so the way back is the breadcrumb (and
   * the sidebar's nav), not a row of buttons that would repeat what the chrome says.
   */
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Select from "$lib/components/ui/select";
  import * as Table from "$lib/components/ui/table";
  import DataTable, { type DataTableColumn, type SortState } from "$lib/components/data-table.svelte";
  import HostAgentAccess from "$lib/dashboard/components/host-agent-access.svelte";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { writeClipboard } from "@pdmux/ui";
  import { discoveredPorts, filterPorts, suggestServiceLabel, type DiscoveredPort } from "@pdmux/core";
  import { fmt, formatDateTime, getI18n } from "$lib/i18n";
  import { agentUpdateApi, errorCode, gitApi, hostsApi, servicesApi, tokensApi } from "$lib/dashboard/api";
  import { offersUpdate, paneSlots, updateInFlight } from "$lib/dashboard/agent-update";
  import AgentUpdateDialog from "$lib/dashboard/components/agent-update-dialog.svelte";
  import AgentVersionCell from "$lib/dashboard/components/agent-version-cell.svelte";
  import ConfirmDialog from "$lib/dashboard/components/confirm-dialog.svelte";
  import HostFormDialog from "$lib/dashboard/components/host-form-dialog.svelte";
  import HostGitRootsCard from "$lib/dashboard/components/host-git-roots-card.svelte";
  import HostInstallDialog from "$lib/dashboard/components/host-install-dialog.svelte";
  import ShellBreadcrumb from "$lib/dashboard/components/shell-breadcrumb.svelte";
  import { hostAddress, hostState, serviceUrl } from "$lib/dashboard/map";
  import { causeMessage, agentUpdateMessage } from "$lib/dashboard/wording";
  import { useShellState } from "$lib/dashboard/shell-state.svelte";
  import type {
    AgentTokenView,
    HostGitRootView,
    HostServiceView,
    MintedAgentToken,
    ProbeKind,
    RepoRow,
  } from "$lib/dashboard/types";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  const shell = useShellState();

  /**
   * The loader's row is the FIRST paint; the shell's feed is every one after it.
   *
   * This page used to read loader data only, so an agent that connected while it
   * was open left the version and the install status frozen until a manual reload.
   * Reading the same feed the cards read costs no extra request — it is already
   * polling — and it is what makes "waiting for the agent… → online" work here too.
   */
  const host = $derived(shell.feed.hosts.find((row) => row.id === data.host.id) ?? data.host);
  const crumbs = $derived([
    { label: i18n.t.dash.title, href: "/", testId: "open-dashboard" },
    { label: i18n.t.dash.hosts.title, href: "/hosts" },
    { label: host.label },
  ]);
  /**
   * The header's status line.
   *
   * `hostState` is the card's own derivation, reused rather than re-derived —
   * two places computing "is this host up" is how they end up disagreeing. It
   * already folds in the disabled case, which is why there are three dots and
   * not two.
   */
  const stateLabel = $derived(
    hostState(host) === "online"
      ? i18n.t.dash.hosts.online
      : hostState(host) === "offline"
        ? i18n.t.dash.hosts.offline
        : i18n.t.dash.hosts.disabled,
  );
  const stateDot = $derived(
    hostState(host) === "online"
      ? "bg-green-500"
      : hostState(host) === "offline"
        ? "bg-destructive"
        : "bg-muted-foreground",
  );
  // A host that never connected is not "last seen a long time ago" — it has no
  // last time at all, and a date formatter would print the epoch for it.
  const lastSeenText = $derived(
    host.lastSeenAt ? formatDateTime(host.lastSeenAt) : i18n.t.dash.hosts.neverSeen,
  );

  /**
   * The connection card's disclosure.
   *
   * ⚠ CLOSED BY DEFAULT ON PURPOSE, and the summary beside the title is what
   * makes that honest — "N keys" is the one fact somebody scanning the page
   * wants from this block, and it is visible without opening anything. The
   * heading and its description stay put too: this is a fold, not a removal.
   */
  let connectionOpen = $state(false);
  let keyCount = $state<number | null>(null);
  const connectionSummary = $derived(
    keyCount === null
      ? ""
      : keyCount > 0
        ? fmt(i18n.t.dash.mcp.summaryKeys, { count: keyCount })
        : i18n.t.dash.mcp.summaryNone,
  );

  let services = $state<HostServiceView[]>(untrack(() => data.services));
  let gitRoots = $state<HostGitRootView[]>(untrack(() => data.gitRoots));
  /**
   * Collected repositories, kept in state because a git-root edit changes them.
   *
   * ⚠ THE AGENT DOES NOT ANSWER INSTANTLY. Adding a path pushes a new config
   * (`notifyChanged`) and the agent then runs a git pass, so the row's
   * `gitRoots.repos` count is a few seconds behind the write. Re-reading on change is
   * what turns a form field into a setting somebody can see took effect.
   */
  let repos = $state<RepoRow[]>(untrack(() => data.repos));

  async function reloadRepos(): Promise<void> {
    try {
      repos = await gitApi.repos(host.id);
    } catch {
      // Leave the previous list: an empty one would read as "the path found
      // nothing", which is a claim this failure cannot support.
    }
  }
  let tokens = $state<AgentTokenView[]>(untrack(() => data.tokens));
  let serviceSort = $state<SortState | null>(null);
  let tokenSort = $state<SortState | null>(null);
  let servicePage = $state(1);
  let tokenPage = $state(1);

  function message(cause: unknown): string {
    const code = errorCode(cause);
    if (code === "FORBIDDEN") return i18n.t.dash.error.forbidden;
    if (code === "HOST_NOT_FOUND" || code === "HOST_SERVICE_NOT_FOUND") return i18n.t.dash.error.notFound;
    if (code === "NETWORK_ERROR") return i18n.t.dash.error.offline;
    return i18n.t.dash.error.generic;
  }

  // --- services -------------------------------------------------------------
  const probes: ProbeKind[] = ["tcp", "http", "none"];
  /**
   * ⚠ `none` IS AN ENGLISH WORD, unlike `tcp` and `http` which are protocol
   * names. Rendering the raw value left one untranslated word sitting in the
   * middle of a Korean table, and in the form's own dropdown.
   */
  const probeLabel = (kind: ProbeKind): string => i18n.t.dash.services.probeKind[kind];
  let serviceOpen = $state(false);
  let editingService = $state<HostServiceView | null>(null);
  let serviceForm = $state({ label: "", port: "", probe: "tcp" as ProbeKind, path: "/", urlTemplate: "" });
  let savingService = $state(false);

  const serviceColumns = $derived<DataTableColumn<HostServiceView>[]>([
    { key: "label", label: i18n.t.dash.services.label, sortable: true },
    { key: "port", label: i18n.t.dash.services.port, sortable: true },
    { key: "probe", label: i18n.t.dash.services.probe },
    { key: "status", label: i18n.t.dash.services.status },
    { key: "url", label: i18n.t.dash.services.url, value: (service) => serviceUrl(host, service) },
    { key: "actions", label: "" },
  ]);

  function openServiceCreate(): void {
    editingService = null;
    serviceForm = { label: "", port: "", probe: "tcp", path: "/", urlTemplate: "" };
    // Reopening must not resume where the last visit left off — a dialog that
    // opens on page 3 of a list looks like it is missing its first rows.
    showFolded = false;
    portQuery = "";
    portPage = 1;
    serviceOpen = true;
  }

  function openServiceEdit(service: HostServiceView): void {
    editingService = service;
    serviceForm = {
      label: service.label,
      port: String(service.port),
      probe: service.probe,
      path: service.path,
      urlTemplate: service.urlTemplate ?? "",
    };
    serviceOpen = true;
  }

  async function submitService(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const port = Number(serviceForm.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      toast.error(i18n.t.dash.error.portRange);
      return;
    }
    savingService = true;
    const input = {
      label: serviceForm.label.trim(),
      port,
      probe: serviceForm.probe,
      path: serviceForm.path.trim() || "/",
      urlTemplate: serviceForm.urlTemplate.trim() || null,
    };
    try {
      if (editingService) await servicesApi.update(host.id, editingService.id, input);
      else await servicesApi.create(host.id, input);
      serviceOpen = false;
      services = await servicesApi.list(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    } finally {
      savingService = false;
    }
  }

  let serviceDeleteOpen = $state(false);
  let deletingService = $state<HostServiceView | null>(null);

  async function confirmServiceDelete(): Promise<void> {
    const service = deletingService;
    if (!service) return;
    try {
      await servicesApi.remove(host.id, service.id);
      services = await servicesApi.list(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  async function moveService(service: HostServiceView, delta: number): Promise<void> {
    const ordered = [...services].sort((a, b) => a.sortOrder - b.sortOrder);
    const from = ordered.findIndex((row) => row.id === service.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const moved = ordered[from];
    const target = ordered[to];
    if (!moved || !target) return;
    ordered[from] = target;
    ordered[to] = moved;
    try {
      services = await servicesApi.reorder(host.id, ordered.map((row) => row.id));
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  // --- discovered ports -----------------------------------------------------

  /**
   * Ports the agent found listening, minus the ones already registered above.
   *
   * ⚠ FROM `host`, NOT FROM `data` — this is the shell's polling feed, so a dev
   * server started while the page is open appears on the next beat. The services
   * list beside it is the loader's snapshot plus explicit refetches, which is why
   * the two are read from different places.
   */
  const ports = $derived(
    discoveredPorts(
      host.listeners,
      services.map((service) => service.port),
    ),
  );

  /**
   * ⚠ THIS IS WHAT KEEPS AN EMPTY TABLE HONEST. A host with no way to enumerate
   * its ports sends the same empty array as a host with nothing listening, and
   * the agent's diagnostic is the only thing that separates them. Without this
   * the screen would state the stronger of the two claims for free.
   */
  const portsUnavailable = $derived(
    host.diagnostics.some((entry) => entry.code === "listeners.unavailable"),
  );

  let showFolded = $state(false);
  let portQuery = $state("");
  let portSort = $state<SortState | null>(null);
  let portPage = $state(1);

  const searching = $derived(portQuery.trim().length > 0);

  /**
   * The picker's rows.
   *
   * ⚠ SEARCH LOOKS AT THE FOLDED PORTS TOO, AND THAT IS NOT A DETAIL. Folding is
   * a guess about what to show FIRST; it never claimed those ports were absent.
   * A search restricted to the visible half answers "no results" for a port the
   * person can see with `lsof` — which reads as a broken tool and sends them back
   * to ssh, the exact outcome this dialog exists to prevent. The rows keep their
   * fold badge so the answer also explains why it was not there already.
   *
   * ⚠ APPENDED RATHER THAN A SECOND TABLE while browsing, because this list is
   * paginated: two tables in one dialog means two page counters and a reader who
   * has to notice there is a second thing to page through. Browsing keeps the
   * unfolded ports first so page one stays the useful one; a search sorts by port,
   * because at that point the reader has told us what they are looking for.
   */
  const pickerRows = $derived(
    searching
      ? filterPorts([...ports.shown, ...ports.folded].sort((a, b) => a.port - b.port), portQuery)
      : showFolded
        ? [...ports.shown, ...ports.folded]
        : ports.shown,
  );

  /**
   * ⚠ FIVE, BECAUSE THE LIST LIVES IN A DIALOG. A developer's machine listens on
   * dozens of ports (measured: sixty on one Mac), and a dialog that grows with
   * them pushes its own Create button off the screen.
   */
  const PORTS_PER_PAGE = 5;

  const portColumns = $derived<DataTableColumn<DiscoveredPort>[]>([
    { key: "port", label: i18n.t.dash.services.port, sortable: true },
    { key: "process", label: i18n.t.dash.ports.process, sortable: true },
    { key: "reach", label: i18n.t.dash.ports.reach },
    { key: "actions", label: "" },
  ]);

  function foldLabel(reason: DiscoveredPort["folded"]): string {
    if (reason === "ephemeral") return i18n.t.dash.ports.fold.ephemeral;
    if (reason === "system-port") return i18n.t.dash.ports.fold["system-port"];
    if (reason === "system-process") return i18n.t.dash.ports.fold["system-process"];
    return "";
  }

  /**
   * Fill the open form from a discovered port.
   *
   * Deliberately not a one-click create: the label is a suggestion, the probe kind
   * is a real choice, and a service row is something the agent then probes on every
   * beat. Filling the same form the manual path uses means picking a port adds no
   * second creation path to keep in step with the first.
   */
  function pickPort(entry: DiscoveredPort): void {
    serviceForm = {
      ...serviceForm,
      label: suggestServiceLabel(
        entry,
        services.map((service) => service.label),
      ),
      port: String(entry.port),
    };
  }

  /**
   * Turn a registered service off (or back on).
   *
   * ⚠ OPTIMISTIC, THEN RECONCILED. A toggle that only moves after a round trip
   * reads as broken on a slow link, so the row flips first — and a failure puts
   * it back rather than leaving the screen disagreeing with the server.
   */
  async function toggleService(service: HostServiceView): Promise<void> {
    const next = !service.enabled;
    services = services.map((row) => (row.id === service.id ? { ...row, enabled: next } : row));
    try {
      await servicesApi.update(host.id, service.id, { enabled: next });
      services = await servicesApi.list(host.id);
    } catch (cause: unknown) {
      services = services.map((row) => (row.id === service.id ? { ...row, enabled: !next } : row));
      toast.error(message(cause));
    }
  }

  // --- tokens ---------------------------------------------------------------

  /**
   * Three states, not two.
   *
   * "expired" is deliberately its own badge rather than being folded into
   * "revoked": nobody took this token away, it ran out — and that difference is the
   * whole of what an operator has to do next (mint a new one vs. find out who
   * revoked it). It is derived here rather than sent by the server because the
   * server has no reason to hold an opinion that goes stale every second.
   */
  function tokenState(token: AgentTokenView): "revoked" | "expired" | "active" {
    if (token.revokedAt) return "revoked";
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return "expired";
    return "active";
  }

  function tokenStateLabel(token: AgentTokenView): string {
    const state = tokenState(token);
    if (state === "revoked") return i18n.t.dash.tokens.revoked;
    if (state === "expired") return i18n.t.dash.tokens.expired;
    return i18n.t.dash.tokens.active;
  }

  const tokenColumns = $derived<DataTableColumn<AgentTokenView>[]>([
    { key: "name", label: i18n.t.dash.tokens.name, sortable: true },
    { key: "createdAt", label: i18n.t.dash.tokens.created, sortable: true },
    { key: "lastUsedAt", label: i18n.t.dash.tokens.lastUsed, sortable: true },
    { key: "expiresAt", label: i18n.t.dash.tokens.expires, sortable: true },
    { key: "state", label: i18n.t.dash.tokens.state, value: tokenState },
    { key: "actions", label: "" },
  ]);

  let mintOpen = $state(false);
  let mintName = $state("");
  /**
   * The select's value, as a string because that is what `Select.Root` binds.
   * `"never"` is the default and is the ONLY value that sends no field at all.
   */
  let mintExpiry = $state("never");
  const EXPIRY_CHOICES = ["never", "7", "30", "90", "180", "365"];
  let minted = $state<MintedAgentToken | null>(null);
  let copied = $state(false);

  function expiryLabel(value: string): string {
    return value === "never"
      ? i18n.t.dash.tokens.expiryNever
      : fmt(i18n.t.dash.tokens.expiryDays, { days: value });
  }

  /**
   * What the operator runs on the machine.
   *
   * The origin is this app's own, which is what a deployment puts in front of both
   * the browser and the agents; a development stack that splits them still shows a
   * working shape, with only the port to change.
   */
  const installCommand = $derived(
    minted ? `pdmux-agent install --server ${originUrl()} --token ${minted.token}` : "",
  );

  function originUrl(): string {
    return typeof window === "undefined" ? "" : window.location.origin;
  }

  async function mint(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    try {
      minted = await tokensApi.mint(
        host.id,
        mintName.trim() || host.label,
        mintExpiry === "never" ? undefined : Number(mintExpiry),
      );
      mintOpen = false;
      mintName = "";
      mintExpiry = "never";
      copied = false;
      tokens = await tokensApi.list(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  async function rotate(token: AgentTokenView): Promise<void> {
    try {
      minted = await tokensApi.rotate(host.id, token.id);
      copied = false;
      tokens = await tokensApi.list(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  let revokeOpen = $state(false);
  let revoking = $state<AgentTokenView | null>(null);

  async function confirmRevoke(): Promise<void> {
    const token = revoking;
    if (!token) return;
    try {
      await tokensApi.revoke(host.id, token.id);
      tokens = await tokensApi.list(host.id);
    } catch (cause: unknown) {
      toast.error(message(cause));
    }
  }

  async function copyCommand(): Promise<void> {
    // `writeClipboard` rather than `navigator.clipboard`: the latter does not exist
    // on a plain-http origin, which is the self-hosted deployment where "copy the
    // token you will never see again" matters most — and it failed there silently.
    await writeClipboard(installCommand);
    copied = true;
  }

  // --- enrollment + agent update -------------------------------------------
  let installOpen = $state(false);
  let updateOpen = $state(false);
  const openPanes = $derived(paneSlots(shell.layout.slots));

  // Was a second copy of this map, and it had already lost the `NO_CANARY` branch the
  // host list had — the drift `wording.ts` exists to stop.
  const updateMessage = (cause: unknown): string => agentUpdateMessage(cause, i18n.t);

  async function runUpdate(): Promise<void> {
    try {
      await agentUpdateApi.host(host.id, { version: host.latestAgentVersion });
      // The feed carries every phase after this, so there is nothing to poll here.
      await shell.feed.refresh();
    } catch (cause: unknown) {
      toast.error(updateMessage(cause));
    }
  }

  /**
   * Handing this host to another account.
   *
   * ⚠ THE DIALOG'S JOB IS TO SAY WHAT DOES **NOT** HAPPEN. "Move" reads like it
   * might disturb the machine, and the thing an operator actually fears — having to
   * reinstall the agent, or losing history — is exactly what does not occur. What
   * does happen is that the host leaves this account's list, which is easy to
   * under-read and is therefore said plainly.
   */
  let moveOpen = $state(false);
  let moveEmail = $state("");
  let moveError = $state<string | null>(null);
  let moving = $state(false);

  let editOpen = $state(false);
  let removeOpen = $state(false);

  /**
   * Disable or re-enable the host.
   *
   * ⚠ IT DROPS THE AGENT'S SOCKET. The server refuses a disabled host at the upgrade
   * and closes the one it already holds, so this is not a display flag — the machine
   * goes dark until it is enabled again. Reversible by pressing it again, which is
   * why it has no typing gate while delete does.
   */
  async function toggleEnabled(): Promise<void> {
    try {
      await hostsApi.setEnabled(host.id, !host.enabled);
      // The row this page renders comes from the shell's feed, and the feed polls —
      // so nothing is invalidated here; the next tick carries the new value.
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    }
  }

  async function removeHost(): Promise<void> {
    try {
      /**
       * ⚠ THROUGH THE SHELL, NOT `hostsApi.remove` DIRECTLY. Deleting the row is only
       * half of it: any terminal pane pointed at this host has to be demoted to an
       * empty cell and the layout written back, or a slot outlives its host and sits in
       * the grid claiming a connection the server will now refuse. `shell.removeHost`
       * is the one path that does both, and calling the API here instead left exactly
       * that pane behind — caught by TC-PDUI-166, which was written for it.
       */
      await shell.removeHost(host.id);
      // The page is named after a row that no longer exists.
      await goto("/hosts");
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    }
  }

  async function moveHost(): Promise<void> {
    moving = true;
    moveError = null;
    try {
      await hostsApi.move(host.id, moveEmail.trim());
      // It is not ours any more, so there is nothing left to render here.
      await goto("/hosts");
    } catch (cause) {
      moveError = causeMessage(cause, i18n.t);
    } finally {
      moving = false;
    }
  }
</script>

<svelte:head><title>{host.label} · pdmux</title></svelte:head>

<!-- The shell owns the viewport, so this column owns its own scrolling (ARCHITECTURE §7). -->
<div class="flex min-h-0 flex-col gap-6 overflow-y-auto p-6" data-testid="hosts-panel" data-pdmux-region="page">
  <ShellBreadcrumb {crumbs} label={i18n.t.dash.breadcrumbLabel} />

  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold" data-testid="host-title">{host.label}</h1>
      <!--
        ⚠ THE STATE OF THE HOST WAS NOT ON THE PAGE NAMED AFTER IT. Online,
        last seen and os/arch lived only on the sidebar card, so answering "is
        this thing even up?" meant looking away from the page you had opened to
        ask — and on a phone the card may not be on screen at all.

        One wrapping line, all of it from values the page already has: no extra
        request, and `hostState` is the same derivation the card uses so the two
        cannot disagree.
      -->
      <div
        class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm"
        data-testid="host-facts"
      >
        <span class="flex items-center gap-1.5">
          <span class={`size-2 rounded-full ${stateDot}`} aria-hidden="true"></span>
          {stateLabel}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="host-last-seen">{lastSeenText}</span>
        {#if hostAddress(host)}
          <span aria-hidden="true">·</span>
          <span class="truncate">{hostAddress(host)}</span>
        {/if}
        {#if host.os}
          <span aria-hidden="true">·</span>
          <span>{host.os}{host.arch ? `/${host.arch}` : ""}</span>
        {/if}
        <span aria-hidden="true">·</span>
        <AgentVersionCell {host} />
      </div>
    </div>
    {#if data.canManage}
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" onclick={() => (installOpen = true)} data-testid="host-install">
          {i18n.t.dash.enroll.menu}
        </Button>
        <!-- `ahead` is absent by design: that host runs a build newer than anything
             published, and "update" there is a downgrade nobody asked for. -->
        {#if offersUpdate(host.agentVersionState)}
          <Button
            variant={host.agentVersionState === "incompatible" ? "destructive" : "default"}
            disabled={updateInFlight(host.lastUpdate)}
            onclick={() => (updateOpen = true)}
            data-testid="host-update"
          >
            {i18n.t.dash.agent.update}
          </Button>
        {/if}
      </div>
    {/if}
  </div>

  <!--
    ⚠ EVERY CARD ON THIS PAGE CARRIES `shrink-0`, AND IT IS NOT COSMETIC. This
    container is a flex column, which shrinks its children by default, and the
    shadcn `Card` is `overflow-hidden` — so a card taller than the space left
    does not push the column into scrolling, it silently CLIPS its own content.
    Measured on the fleet settings screen: scrollHeight 434 against clientHeight
    160, one field of four reachable.
  -->
  <Card.Root class="shrink-0" data-testid="host-services">
    <Card.Header>
      <Card.Title>{i18n.t.dash.services.title}</Card.Title>
      <Card.Description>{i18n.t.dash.services.subtitle}</Card.Description>
      {#if data.canManage}
        <Card.Action>
          <Button onclick={openServiceCreate} data-testid="service-add">
            <PlusIcon class="size-4" />{i18n.t.dash.services.add}
          </Button>
        </Card.Action>
      {/if}
    </Card.Header>
    <Card.Content>
    <DataTable
      columns={serviceColumns}
      rows={services}
      getKey={(service) => service.id}
      empty={i18n.t.dash.services.empty}
      bind:sort={serviceSort}
      bind:page={servicePage}
      perPage={0}
      label={i18n.t.dash.services.title}
    >
      {#snippet row(service)}
        <Table.Cell class="font-medium">{service.label}</Table.Cell>
        <Table.Cell class="tabular-nums">{service.port}</Table.Cell>
        <Table.Cell class="text-muted-foreground">{probeLabel(service.probe)}</Table.Cell>
        <Table.Cell>
          <!-- ⚠ "off" WINS OVER EVERY PROBE STATE, and it has to. Nothing is
               probing a disabled service, so its last known status is a memory —
               painting it "down" would send somebody after a service that is
               exactly where they parked it. -->
          {#if !service.enabled}
            <Badge variant="secondary" data-testid={`service-off-${service.label}`}>
              {i18n.t.dash.services.off}
            </Badge>
          {:else if service.status === "up"}
            <Badge variant="outline" class="text-green-600 dark:text-green-400">{i18n.t.dash.services.up}</Badge>
          {:else if service.status === "down"}
            <Badge variant="destructive">{i18n.t.dash.services.down}</Badge>
          {:else}
            <Badge variant="secondary">{i18n.t.dash.services.unknown}</Badge>
          {/if}
        </Table.Cell>
        <Table.Cell class="text-muted-foreground max-w-[24rem] truncate">{serviceUrl(host, service)}</Table.Cell>
        <!-- ⚠ THE WHOLE CELL IS GATED, NOT JUST THE ADD BUTTON. Only `service-add`
             checked this, so a read-only member still saw Edit, Turn off and
             Delete on every row and learned they were forbidden by pressing one
             and reading a 403. `/hosts` already wraps its actions cell this way. -->
        <Table.Cell>
          {#if data.canManage}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="icon" data-testid={`service-menu-${service.label}`}>
                  <EllipsisIcon class="size-4" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                onSelect={() => void toggleService(service)}
                data-testid={`service-toggle-${service.label}`}
              >
                {service.enabled ? i18n.t.dash.services.turnOff : i18n.t.dash.services.turnOn}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => openServiceEdit(service)}>{i18n.t.dash.hosts.edit}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void moveService(service, -1)}>
                {i18n.t.dash.hosts.moveUp}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void moveService(service, 1)}>
                {i18n.t.dash.hosts.moveDown}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onSelect={() => {
                  deletingService = service;
                  serviceDeleteOpen = true;
                }}>{i18n.t.dash.hosts.delete}</DropdownMenu.Item
              >
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          {/if}
        </Table.Cell>
      {/snippet}
    </DataTable>
    </Card.Content>
  </Card.Root>

  <!-- Directly under the services card: both answer "what does the agent watch
       here", and the ports card taught the shape this one reuses. -->
  <HostGitRootsCard
    hostId={host.id}
    bind:roots={gitRoots}
    {repos}
    diagnostics={host.diagnostics}
    fleetGitRoots={data.fleetGitRoots}
    scanIntervalSec={data.gitIntervalSec}
    canManage={data.canManage}
    onChanged={() => void reloadRepos()}
  />

  <Card.Root class="shrink-0" data-testid="host-tokens">
    <Card.Header>
      <Card.Title>{i18n.t.dash.tokens.title}</Card.Title>
      <Card.Description>{i18n.t.dash.tokens.subtitle}</Card.Description>
      {#if data.canManage}
        <Card.Action>
          <Button
            onclick={() => {
              mintName = host.label;
              mintOpen = true;
            }}
            data-testid="token-mint"
          >
            <PlusIcon class="size-4" />{i18n.t.dash.tokens.mint}
          </Button>
        </Card.Action>
      {/if}
    </Card.Header>
    <Card.Content>
    <DataTable
      columns={tokenColumns}
      rows={tokens}
      getKey={(token) => token.id}
      empty={i18n.t.dash.tokens.empty}
      bind:sort={tokenSort}
      bind:page={tokenPage}
      perPage={0}
      label={i18n.t.dash.tokens.title}
    >
      {#snippet row(token)}
        <Table.Cell class="font-medium">{token.name}</Table.Cell>
        <Table.Cell class="text-muted-foreground">{formatDateTime(token.createdAt)}</Table.Cell>
        <Table.Cell class="text-muted-foreground">
          {token.lastUsedAt ? formatDateTime(token.lastUsedAt) : i18n.t.dash.tokens.never}
        </Table.Cell>
        <Table.Cell class="text-muted-foreground" data-testid={`token-expiry-${token.name}`}>
          {token.expiresAt
            ? fmt(i18n.t.dash.tokens.expiresOn, { date: token.expiresAt.slice(0, 10) })
            : i18n.t.dash.tokens.expiryNever}
        </Table.Cell>
        <Table.Cell>
          {#if tokenState(token) === "revoked"}
            <Badge variant="secondary">{tokenStateLabel(token)}</Badge>
          {:else if tokenState(token) === "expired"}
            <!-- Not "revoked": nobody took it away, it ran out — and the fix differs. -->
            <Badge variant="outline" data-testid={`token-expired-${token.name}`}>{tokenStateLabel(token)}</Badge>
          {:else}
            <Badge variant="outline" class="text-green-600 dark:text-green-400">{tokenStateLabel(token)}</Badge>
          {/if}
        </Table.Cell>
        <!-- Same gate as the service rows: rotate and revoke are fleet-management. -->
        <Table.Cell>
          {#if data.canManage}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="icon" data-testid={`token-menu-${token.name}`}>
                  <EllipsisIcon class="size-4" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item disabled={Boolean(token.revokedAt)} onSelect={() => void rotate(token)}>
                {i18n.t.dash.tokens.rotate}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={Boolean(token.revokedAt)}
                onSelect={() => {
                  revoking = token;
                  revokeOpen = true;
                }}>{i18n.t.dash.tokens.revoke}</DropdownMenu.Item
              >
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          {/if}
        </Table.Cell>
      {/snippet}
    </DataTable>
    </Card.Content>
  </Card.Root>

  <!--
    Connecting a coding CLI: the credential, the config, and the handoff.

    ⚠ COLLAPSED BY DEFAULT, AND THAT IS WHERE THIS PAGE GOT ITS SCREEN BACK.
    Measured: this block is ~1,130px of a ~1,980px page — 57% — and it is five
    code blocks and six paragraphs of instruction. Exactly two of its controls
    change anything on the server (create a key, revoke one), together about 11%
    of its own height. It is read once when a CLI is attached and never again,
    yet it outweighed everything an operator actually returns to.

    ⚠ FOLDED, NEVER DROPPED — the same house rule as the port picker's
    `ports-folded-toggle`. The title stays, and the summary says how many keys
    exist, so nothing disappears: it stops shouting.
  -->
  <Collapsible.Root bind:open={connectionOpen}>
    <Card.Root class="shrink-0" data-testid="host-connection">
      <Collapsible.Trigger
        class="hover:bg-muted/40 w-full cursor-pointer rounded-xl text-left transition-colors"
        aria-label={connectionOpen ? i18n.t.dash.mcp.collapse : i18n.t.dash.mcp.expand}
        data-testid="host-connection-toggle"
      >
        <Card.Header>
          <Card.Title class="flex items-center gap-2">
            <ChevronRightIcon
              class={`size-4 transition-transform ${connectionOpen ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            {i18n.t.dash.mcp.title}
          </Card.Title>
          <Card.Description>{i18n.t.dash.mcp.intro}</Card.Description>
          <Card.Action>
            <span class="text-muted-foreground text-sm" data-testid="host-connection-summary">
              {connectionSummary}
            </span>
          </Card.Action>
        </Card.Header>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Card.Content>
          <HostAgentAccess {host} canManage={data.canManage} bind:keyCount />
        </Card.Content>
      </Collapsible.Content>
    </Card.Root>
  </Collapsible.Root>

  {#if data.canManage}
    <!--
      Everything that changes the host ITSELF, in one place at the end of the page.

      ⚠ THREE OF THESE USED TO EXIST ONLY IN THE CARD'S ⚙ POPOVER. Editing a host,
      disabling it and deleting it were reachable from a 260px panel beside the
      sidebar and from nowhere else on this page — so the page that is named after
      the host could not change it. The popover is an entry point,
      and an irreversible action is not an entry.

      ⚠ SO THESE FIVE STAY VISIBLE. It is tempting to fold this card away with
      the rest of the page's weight, but TC-PDUI-182 asserts `host-edit`,
      `host-install`, `host-toggle-enabled`, `host-move-open` and `host-remove`
      are all visible one hop from the card — and that assertion exists because
      burying them is the bug the previous release fixed. The screen is bought
      back from the connection block instead.

      Ordered by cost, and the two that cannot be undone by clicking again sit last.
    -->
    <Card.Root class="border-destructive/50 shrink-0" data-testid="host-danger">
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
          {i18n.t.dash.hosts.dangerTitle}
        </Card.Title>
        <Card.Description>{i18n.t.dash.hosts.dangerIntro}</Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" data-testid="host-edit" onclick={() => (editOpen = true)}>
          {i18n.t.dash.hosts.edit}
        </Button>
        <!-- Reversible by pressing it again, so it needs no gate — but it does drop the
             agent's socket, which is why it says so rather than toggling silently. -->
        <Button
          variant="outline"
          size="sm"
          data-testid="host-toggle-enabled"
          onclick={() => void toggleEnabled()}
        >
          {host.enabled ? i18n.t.dash.hosts.disable : i18n.t.dash.hosts.enable}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="host-move-open"
          onclick={() => {
            moveEmail = "";
            moveError = null;
            moveOpen = true;
          }}
        >
          {i18n.t.dash.hosts.moveAction}
        </Button>
        <Button variant="destructive" size="sm" data-testid="host-remove" onclick={() => (removeOpen = true)}>
          {i18n.t.dash.hosts.deleteTitle}
        </Button>
      </div>

      <!-- Correcting the owner. Registration happens under whichever account was
           signed in, so a machine routinely lands in the wrong one. -->
      <p class="text-muted-foreground text-xs" data-testid="host-move-intro">{i18n.t.dash.hosts.moveIntro}</p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<Dialog.Root bind:open={serviceOpen}>
  <!--
    ⚠ THE DEFAULT DIALOG IS TOO NARROW FOR A TABLE, AND IT DOES NOT SAY SO.
    `sm:max-w-sm` is 384px; the port picker measured 512px and simply drew past
    the panel — the "use this" button of every row sat 108px OUTSIDE the dialog,
    on the dimmed backdrop, where it is neither clickable nor visibly part of
    anything. The panel's own `scrollWidth 544 > clientWidth 384` said the same,
    and nothing about the screenshot looked broken enough to catch by eye.

    Two fixes, because either alone leaves the trap armed: the dialog is widened
    for the picker, and the table is put in its own horizontal scroller so a
    future column can never push the panel again. The height cap is the same
    argument vertically — expanding the folded ports adds rows.
  -->
  <Dialog.Content
    data-testid="service-form"
    class={editingService ? "max-h-[85vh] overflow-y-auto" : "max-h-[85vh] overflow-y-auto sm:max-w-2xl"}
  >
    <Dialog.Header>
      <Dialog.Title>{editingService ? i18n.t.dash.services.editTitle : i18n.t.dash.services.addTitle}</Dialog.Title>
    </Dialog.Header>
    {#if !editingService}
      <!--
        Pick the port instead of typing it.

        ⚠ THIS REPLACED A SEPARATE TABLE FURTHER DOWN THE PAGE. The same list in
        two places is two things to keep in step, and the second one was where a
        person had to go BEFORE they could use the button they had already
        pressed. Registering a port is the only thing that list was ever for.
      -->
      <div class="flex flex-col gap-2" data-testid="service-port-picker">
        <p class="text-muted-foreground text-sm">{i18n.t.dash.ports.pickIntro}</p>
        {#if host.listeners === null}
          <!-- ⚠ NOT "nothing is listening". This agent predates the field, so it
               said nothing at all — and stating the stronger claim on its behalf
               is what this branch exists to stop. -->
          <p class="text-muted-foreground text-sm" data-testid="ports-unreported">
            {i18n.t.dash.ports.unreported}
          </p>
        {:else if portsUnavailable}
          <p class="text-muted-foreground text-sm" data-testid="ports-unavailable">
            {i18n.t.dash.ports.unavailable}
          </p>
        {/if}
        <!-- ⚠ A PLAIN INPUT, NOT THE SHARED `table-toolbar`. That toolbar commits on
             a Search button so several conditions apply in one pass against a
             server; here the rows are already in the browser, so filtering per
             keystroke is both instant and correct — and a second button inside a
             dialog that already has "create" is one button too many. -->
        <Input
          bind:value={portQuery}
          oninput={() => (portPage = 1)}
          placeholder={i18n.t.dash.ports.search}
          data-testid="port-search"
        />
        <div class="w-full overflow-x-auto">
          <DataTable
            columns={portColumns}
            rows={pickerRows}
            getKey={(entry) => entry.port}
            empty={searching ? i18n.t.dash.ports.searchNoMatch : i18n.t.dash.ports.empty}
            bind:sort={portSort}
            bind:page={portPage}
            perPage={PORTS_PER_PAGE}
            label={i18n.t.dash.ports.title}
          >
            {#snippet row(entry)}
            <Table.Cell class="tabular-nums font-medium">{entry.port}</Table.Cell>
            <Table.Cell class="text-muted-foreground">
              {entry.process || i18n.t.dash.ports.unnamed}
            </Table.Cell>
            <Table.Cell>
              {#if entry.folded}
                <Badge variant="secondary">{foldLabel(entry.folded)}</Badge>
              {:else if entry.loopbackOnly}
                <!-- Not decoration: a port bound only to loopback is very often
                     unauthenticated precisely because its author reasoned nothing
                     off the machine could reach it. -->
                <Badge variant="secondary">{i18n.t.dash.ports.loopback}</Badge>
              {:else}
                <Badge variant="outline">{i18n.t.dash.ports.exposed}</Badge>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <Button
                variant={serviceForm.port === String(entry.port) ? "secondary" : "ghost"}
                size="sm"
                onclick={() => pickPort(entry)}
                data-testid={`port-pick-${entry.port}`}
              >
                {i18n.t.dash.ports.pick}
              </Button>
            </Table.Cell>
            {/snippet}
          </DataTable>
        </div>
        {#if searching}
          <p class="text-muted-foreground text-xs">{i18n.t.dash.ports.searchIncludesFolded}</p>
        {:else if ports.folded.length > 0}
          <!-- ⚠ FOLDED, NEVER DROPPED. A list that silently loses the port
               somebody came here for does not read as "we filtered that" — it
               reads as a broken tool, and they go back to ssh, which is the
               workflow this dialog replaces. -->
          <div>
            <Button
              variant="ghost"
              size="sm"
              onclick={() => {
                showFolded = !showFolded;
                portPage = 1;
              }}
              data-testid="ports-folded-toggle"
            >
              {showFolded
                ? i18n.t.dash.ports.hideFolded
                : fmt(i18n.t.dash.ports.showFolded, { count: ports.folded.length })}
            </Button>
          </div>
          {#if showFolded}
            <p class="text-muted-foreground text-xs">{i18n.t.dash.ports.foldedNote}</p>
          {/if}
        {/if}
      </div>
    {/if}
    <form onsubmit={submitService} class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <Label for="service-label">{i18n.t.dash.services.label}</Label>
        <Input id="service-label" bind:value={serviceForm.label} required data-testid="service-label" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="service-port">{i18n.t.dash.services.port}</Label>
        <Input id="service-port" bind:value={serviceForm.port} inputmode="numeric" required data-testid="service-port" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label>{i18n.t.dash.services.probe}</Label>
        <Select.Root type="single" bind:value={serviceForm.probe}>
          <Select.Trigger data-testid="service-probe">{probeLabel(serviceForm.probe)}</Select.Trigger>
          <Select.Content>
            {#each probes as probe (probe)}
              <Select.Item value={probe}>{probeLabel(probe)}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="service-path">{i18n.t.dash.services.path}</Label>
        <Input id="service-path" bind:value={serviceForm.path} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="service-url">{i18n.t.dash.services.urlTemplate}</Label>
        <Input id="service-url" bind:value={serviceForm.urlTemplate} />
        <p class="text-muted-foreground text-xs">{i18n.t.dash.services.urlTemplateHint}</p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (serviceOpen = false)}>{i18n.t.dash.form.cancel}</Button>
        <Button type="submit" disabled={savingService} data-testid="service-save">
          {editingService ? i18n.t.dash.form.save : i18n.t.dash.form.create}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={mintOpen}>
  <Dialog.Content data-testid="token-form">
    <Dialog.Header><Dialog.Title>{i18n.t.dash.tokens.mint}</Dialog.Title></Dialog.Header>
    <form onsubmit={mint} class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <Label for="token-name">{i18n.t.dash.tokens.name}</Label>
        <Input id="token-name" bind:value={mintName} required data-testid="token-name" />
      </div>
      <!-- Defaults to "Never", which is what a real machine wants: the agent cannot
           renew its own credential, so an expiry here is an outage with a calendar
           unless somebody chose it deliberately. -->
      <div class="flex flex-col gap-1.5">
        <Label for="token-expiry">{i18n.t.dash.tokens.expiryLabel}</Label>
        <Select.Root type="single" bind:value={mintExpiry}>
          <Select.Trigger id="token-expiry" data-testid="token-expiry">{expiryLabel(mintExpiry)}</Select.Trigger>
          <Select.Content>
            {#each EXPIRY_CHOICES as choice (choice)}
              <Select.Item value={choice}>{expiryLabel(choice)}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <p class="text-muted-foreground text-xs">{i18n.t.dash.tokens.expiryHint}</p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (mintOpen = false)}>{i18n.t.dash.form.cancel}</Button>
        <Button type="submit" data-testid="token-save">{i18n.t.dash.tokens.mint}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(minted)} onOpenChange={(open: boolean) => !open && (minted = null)}>
  <Dialog.Content data-testid="token-reveal">
    <Dialog.Header><Dialog.Title>{i18n.t.dash.tokens.plaintextTitle}</Dialog.Title></Dialog.Header>
    <p class="text-muted-foreground text-sm">{i18n.t.dash.tokens.plaintextWarning}</p>
    <p class="text-sm">{i18n.t.dash.tokens.installHint}</p>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="token-install">{installCommand}</pre>
    <Dialog.Footer>
      <Button variant="outline" onclick={copyCommand} data-testid="token-copy">
        {copied ? i18n.t.dash.tokens.copied : i18n.t.dash.tokens.copy}
      </Button>
      <Button data-testid="token-reveal-close" onclick={() => (minted = null)}>{i18n.t.dash.tokens.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<HostInstallDialog bind:open={installOpen} {host} fallbackLabel={host.label} />

<AgentUpdateDialog bind:open={updateOpen} {host} slots={openPanes} onConfirm={runUpdate} />

<!-- The same component the host list uses, so "edit a host" means one form
     everywhere rather than a second one that drifts. -->
<HostFormDialog bind:open={editOpen} {host} />

<ConfirmDialog
  bind:open={removeOpen}
  title={i18n.t.dash.hosts.deleteTitle}
  warning={fmt(i18n.t.dash.hosts.deleteWarning, { label: host.label })}
  label={host.label}
  confirmLabel={i18n.t.dash.hosts.delete}
  testId="host-delete"
  onConfirm={removeHost}
/>

<ConfirmDialog
  bind:open={serviceDeleteOpen}
  title={i18n.t.dash.services.deleteTitle}
  warning={fmt(i18n.t.dash.services.deleteWarning, { label: deletingService?.label ?? "" })}
  label={deletingService?.label ?? ""}
  confirmLabel={i18n.t.dash.hosts.delete}
  testId="service-delete"
  onConfirm={confirmServiceDelete}
/>

<ConfirmDialog
  bind:open={revokeOpen}
  title={i18n.t.dash.tokens.revokeTitle}
  warning={fmt(i18n.t.dash.tokens.revokeWarning, { label: revoking?.name ?? "" })}
  label={revoking?.name ?? ""}
  confirmLabel={i18n.t.dash.tokens.revoke}
  testId="token-revoke"
  onConfirm={confirmRevoke}
/>

<Dialog.Root bind:open={moveOpen}>
  <Dialog.Content data-testid="host-move-dialog">
    <Dialog.Header>
      <Dialog.Title>{i18n.t.dash.hosts.moveTitle}</Dialog.Title>
      <Dialog.Description>{fmt(i18n.t.dash.hosts.moveWarning, { label: host.label })}</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-1.5">
      <Label for="move-email">{i18n.t.dash.hosts.moveEmail}</Label>
      <Input id="move-email" type="email" bind:value={moveEmail} data-testid="host-move-email" />
    </div>
    <!-- What does NOT happen. This is the part an operator is actually unsure of. -->
    <p class="text-muted-foreground text-xs" data-testid="host-move-keeps">{i18n.t.dash.hosts.moveKeeps}</p>
    {#if moveError}
      <p class="text-destructive text-sm" data-testid="host-move-error">{moveError}</p>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (moveOpen = false)}>{i18n.t.dash.tokens.close}</Button>
      <Button disabled={moving || moveEmail.trim().length === 0} onclick={() => void moveHost()}
        data-testid="host-move-confirm">{i18n.t.dash.hosts.moveAction}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
