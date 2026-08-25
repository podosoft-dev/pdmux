<script lang="ts">
  /**
   * Where this host's agent looks for git checkouts.
   *
   * WHY IT IS A CARD OF ITS OWN: the list used to be fleet-wide, and the value is
   * an absolute path ON ONE MACHINE. One list shared by every host is only right
   * while every host has the same layout; the first one that does not reports
   * `git.root_missing` for ever and shows an empty git graph, which is
   * indistinguishable from "nothing configured".
   *
   * ⚠ THE STATUS COLUMN IS THE POINT OF THE SCREEN. A path is typed here and used
   * somewhere else, so a typo is the only real failure mode — and the diagnostic
   * that catches it has existed in the agent the whole time without anything
   * rendering it.
   */
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable, { type DataTableColumn, type SortState } from "#lib/components/data-table.svelte";
  import ConfirmDialog from "./confirm-dialog.svelte";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { toast } from "svelte-sonner";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { errorCode, gitRootsApi } from "../api";
  import { causeMessage } from "../wording";
  import { gitMissing, gitRootRows, type GitRootRow } from "../git-roots";
  import type { AgentDiagnostic } from "@pdmux/protocol";
  import type { HostGitRootView, RepoRow } from "../types";

  let {
    hostId,
    roots = $bindable([]),
    repos = [],
    diagnostics = [],
    fleetGitRoots = [],
    scanIntervalSec = 120,
    canManage = false,
    onChanged,
  }: {
    hostId: string;
    roots?: HostGitRootView[];
    /** Collected repositories — the evidence a typed path was the right one. */
    repos?: RepoRow[];
    diagnostics?: AgentDiagnostic[];
    /** What this host falls back to while it has no rows of its own. */
    fleetGitRoots?: string[];
    /**
     * The fleet's `gitIntervalSec` — how long a just-added path can honestly say
     * "nobody has looked yet" before an empty result becomes a real answer.
     */
    scanIntervalSec?: number;
    canManage?: boolean;
    /** A write landed; the caller re-reads the repositories the agent then finds. */
    onChanged?: () => void;
  } = $props();

  const i18n = getI18n();
  /**
   * ⚠ A CLOCK IS AN INPUT HERE, so it has to keep moving. `gitRoots.pending` expires on
   * elapsed time, and a `$derived` over static props would freeze at whatever the
   * page load happened to see — the row would sit on `gitRoots.pending` until something
   * else re-rendered it, which is the same shape of lie as the one this replaces.
   */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(timer);
  });
  const rows = $derived(gitRootRows(roots, repos, diagnostics, now, scanIntervalSec));
  const noGit = $derived(gitMissing(diagnostics));

  let sort = $state<SortState>({ key: "path", dir: "asc" });
  let page = $state(1);

  const columns: DataTableColumn<GitRootRow>[] = [
    { key: "path", label: i18n.t.dash.gitRoots.path },
    { key: "status", label: i18n.t.dash.gitRoots.status },
    { key: "repos", label: i18n.t.dash.gitRoots.repos },
    { key: "actions", label: "", sortable: false },
  ];

  let formOpen = $state(false);
  let editing = $state<HostGitRootView | null>(null);
  let pathInput = $state("");
  let saving = $state(false);
  let deleting = $state<HostGitRootView | null>(null);
  let deleteOpen = $state(false);

  function openCreate(): void {
    editing = null;
    pathInput = "";
    formOpen = true;
  }

  function openEdit(root: HostGitRootView): void {
    editing = root;
    pathInput = root.path;
    formOpen = true;
  }

  /**
   * ⚠ BRANCH ON THE CODE, NOT THE MESSAGE. The server has a sentence for each of
   * these, but it is written for an API client — "That path is already listed"
   * next to a Korean form is the wrong voice, and the limit needs the number
   * spelled into the local string.
   *
   * A DTO rejection is deliberately NOT branched on: `class-validator` failures
   * all arrive as one `HTTP_ERROR`, so "must be absolute" and "too long" are the
   * same code and picking either sentence would be a guess. Both are caught below
   * before the request goes out, where they can be told apart.
   */
  function reportFailure(error: unknown): void {
    const code = errorCode(error);
    if (code === "HOST_GIT_ROOT_PATH_TAKEN") toast.error(i18n.t.dash.gitRoots.duplicate);
    else if (code === "HOST_GIT_ROOT_LIMIT") toast.error(fmt(i18n.t.dash.gitRoots.limit, { max: 32 }));
    // Anything else is one of the four outcomes every screen shares, so it
    // reads from the one map rather than inventing a fifth sentence here.
    else toast.error(causeMessage(error, i18n.t));
  }

  async function save(): Promise<void> {
    const path = pathInput.trim();
    if (!path || saving) return;
    // Caught here as well as on the server: a round trip to be told about a
    // leading slash is a round trip nobody needs.
    if (!path.startsWith("/")) {
      toast.error(i18n.t.dash.gitRoots.notAbsolute);
      return;
    }
    // The contract caps a path at 1024 characters and the DTO matches it, so
    // sending a longer one buys a 400 that says only "HTTP_ERROR".
    if (path.length > 1024) {
      toast.error(fmt(i18n.t.dash.gitRoots.tooLong, { max: 1024 }));
      return;
    }
    saving = true;
    try {
      if (editing) {
        const saved = await gitRootsApi.update(hostId, editing.id, { path });
        roots = roots.map((row) => (row.id === saved.id ? saved : row));
      } else {
        roots = [...roots, await gitRootsApi.create(hostId, path)];
      }
      formOpen = false;
      onChanged?.();
    } catch (error) {
      reportFailure(error);
    } finally {
      saving = false;
    }
  }

  async function toggle(root: HostGitRootView): Promise<void> {
    try {
      const saved = await gitRootsApi.update(hostId, root.id, { enabled: !root.enabled });
      roots = roots.map((row) => (row.id === saved.id ? saved : row));
      onChanged?.();
    } catch (error) {
      reportFailure(error);
    }
  }

  async function remove(): Promise<void> {
    const target = deleting;
    if (!target) return;
    try {
      await gitRootsApi.remove(hostId, target.id);
      roots = roots.filter((row) => row.id !== target.id);
      deleteOpen = false;
      onChanged?.();
    } catch (error) {
      reportFailure(error);
    }
  }

  function statusLabel(row: GitRootRow): string {
    if (row.status === "off") return i18n.t.dash.gitRoots.off;
    if (row.status === "missing") return i18n.t.dash.gitRoots.missing;
    if (row.status === "found") return i18n.t.dash.gitRoots.found;
    if (row.status === "pending") return i18n.t.dash.gitRoots.pending;
    return i18n.t.dash.gitRoots.empty;
  }
</script>

<!-- `shrink-0` for the reason every card on this page carries it: the column is a
     flex parent and `Card` is `overflow-hidden`, so a tall card clips itself. -->
<Card.Root class="shrink-0" data-testid="host-git-roots">
  <Card.Header>
    <Card.Title>{i18n.t.dash.gitRoots.title}</Card.Title>
    <Card.Description>{i18n.t.dash.gitRoots.subtitle}</Card.Description>
    {#if canManage}
      <Card.Action>
        <Button onclick={openCreate} data-testid="git-root-add">
          <PlusIcon class="size-4" />{i18n.t.dash.gitRoots.add}
        </Button>
      </Card.Action>
    {/if}
  </Card.Header>
  <Card.Content class="space-y-3">
    <!-- ⚠ THIS OUTRANKS EVERY ROW BELOW IT. Without git on the host, a correct
         path collects nothing and its row would still say `gitRoots.empty` — which
         sends somebody to check a path that was never the problem. -->
    {#if noGit}
      <p class="text-muted-foreground flex items-center gap-2 text-sm" data-testid="git-root-no-git">
        <TriangleAlertIcon class="size-4 shrink-0" />{i18n.t.dash.gitRoots.gitMissing}
      </p>
    {/if}

    {#if roots.length === 0}
      <!-- Two silences, and they are not the same thing. A host with no rows is
           still collecting from the fleet list; saying "no paths" there would be
           false, and hiding the fleet's paths would make the graph's contents
           unexplainable from this screen. -->
      {#if fleetGitRoots.length > 0}
        <p class="text-muted-foreground text-sm" data-testid="git-root-empty-fleet">
          {fmt(i18n.t.dash.gitRoots.emptyFleet, { paths: fleetGitRoots.join(", ") })}
        </p>
        <p class="text-muted-foreground text-xs">{i18n.t.dash.gitRoots.emptyFleetHint}</p>
      {:else}
        <p class="text-muted-foreground text-sm" data-testid="git-root-empty">
          {i18n.t.dash.gitRoots.emptyNoFleet}
        </p>
      {/if}
    {:else}
      <DataTable
        {columns}
        {rows}
        getKey={(row) => row.root.id}
        empty={i18n.t.dash.gitRoots.emptyNoFleet}
        bind:sort
        bind:page
        perPage={0}
        label={i18n.t.dash.gitRoots.title}
      >
        {#snippet row(entry)}
          <Table.Cell class="max-w-[28rem] truncate font-medium">{entry.root.path}</Table.Cell>
          <Table.Cell>
            {#if entry.status === "off"}
              <Badge variant="secondary" data-testid={`git-root-off-${entry.root.path}`}>
                {statusLabel(entry)}
              </Badge>
            {:else if entry.status === "missing"}
              <!-- The one row somebody has to act on, and the hint says what to do
                   with it — the path is on another machine, so "check it exists"
                   is not obvious advice. -->
              <Badge
                variant="destructive"
                title={i18n.t.dash.gitRoots.missingHint}
                data-testid={`git-root-missing-${entry.root.path}`}
              >
                {statusLabel(entry)}
              </Badge>
            {:else if entry.status === "found"}
              <Badge variant="outline" class="text-green-600 dark:text-green-400">{statusLabel(entry)}</Badge>
            {:else if entry.status === "pending"}
              <!-- ⚠ NOT `gitRoots.empty`. The agent scans on a timer and a changed
                   root list does not re-arm it, so a path saved a moment ago is
                   genuinely unanswered — saying "none" there is the app claiming
                   a result nobody produced. -->
              <Badge
                variant="secondary"
                title={fmt(i18n.t.dash.gitRoots.pendingHint, { sec: scanIntervalSec })}
                data-testid={`git-root-pending-${entry.root.path}`}
              >
                {statusLabel(entry)}
              </Badge>
            {:else}
              <Badge variant="secondary">{statusLabel(entry)}</Badge>
            {/if}
          </Table.Cell>
          <Table.Cell class="text-muted-foreground tabular-nums">
            {entry.repoCount > 0 ? fmt(i18n.t.dash.gitRoots.repoCount, { count: entry.repoCount }) : "—"}
          </Table.Cell>
          <Table.Cell>
            <!-- The whole cell is gated, as on the services card: a read-only
                 member offered Edit and Delete learns they are forbidden by
                 pressing one and reading a 403. -->
            {#if canManage}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon"
                      data-testid={`git-root-menu-${entry.root.path}`}
                    >
                      <EllipsisIcon class="size-4" />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item
                    onSelect={() => void toggle(entry.root)}
                    data-testid={`git-root-toggle-${entry.root.path}`}
                  >
                    {entry.root.enabled ? i18n.t.dash.gitRoots.turnOff : i18n.t.dash.gitRoots.turnOn}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => openEdit(entry.root)}>
                    {i18n.t.dash.hosts.edit}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    onSelect={() => {
                      deleting = entry.root;
                      deleteOpen = true;
                    }}>{i18n.t.dash.hosts.delete}</DropdownMenu.Item
                  >
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {/if}
          </Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={formOpen}>
  <Dialog.Content data-testid="git-root-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {editing ? i18n.t.dash.gitRoots.editTitle : i18n.t.dash.gitRoots.addTitle}
      </Dialog.Title>
    </Dialog.Header>
    <div class="space-y-2">
      <Label for="git-root-path">{i18n.t.dash.gitRoots.path}</Label>
      <Input
        id="git-root-path"
        bind:value={pathInput}
        placeholder={i18n.t.dash.gitRoots.pathPlaceholder}
        data-testid="git-root-path"
      />
      <p class="text-muted-foreground text-xs">{i18n.t.dash.gitRoots.pathHint}</p>
      <!-- ⚠ NOT OPTIONAL COPY. `discover.go` walks ONE level each way. Without
           this sentence people enter their home directory, wait, and report that
           discovery is broken. -->
      <p class="text-muted-foreground flex gap-2 text-xs">
        <TriangleAlertIcon class="size-4 shrink-0" />{i18n.t.dash.gitRoots.pathDepthWarning}
      </p>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (formOpen = false)}>{i18n.t.dash.form.cancel}</Button>
      <Button onclick={() => void save()} disabled={saving} data-testid="git-root-save">
        {i18n.t.dash.form.save}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={deleteOpen}
  title={i18n.t.dash.gitRoots.deleteTitle}
  warning={fmt(i18n.t.dash.gitRoots.deleteWarning, { path: deleting?.path ?? "" })}
  label={deleting?.path ?? ""}
  testId="git-root-delete"
  onConfirm={remove}
/>
