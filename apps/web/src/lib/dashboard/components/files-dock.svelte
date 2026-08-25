<script lang="ts">
  /**
   * The file explorer's controls: which host, where in it, and what to do there.
   *
   * ⚠ THE CONTROLS ARE HERE AND THE LISTING IS IN `@pdmux/ui` — the split
   * `ui-changes.md` records. The package cannot use shadcn, so a select or a
   * toolbar built inside it comes out as a look-alike beside real ones; and the
   * package may not fetch (`[TC-PDUI-030]`), so the network belongs here too.
   */
  import { FileExplorer, type SelectMode, type Translate } from "@pdmux/ui";
  import type { FsColumnKey, FsSortKey } from "@pdmux/core";
  import { mode as colourScheme } from "mode-watcher";
  import CheckIcon from "@lucide/svelte/icons/check";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { toast } from "svelte-sonner";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import type { FilesDock } from "../files-dock.svelte";
  import type { HostView } from "../types";
  import ConfirmDialog from "./confirm-dialog.svelte";

  interface Props {
    files: FilesDock;
    hosts: readonly HostView[];
    t?: Translate;
    onHostChange: (hostId: string) => void;
    /** Navigating is the app's, not the store's: the layout records where we are. */
    onOpenDir: (path: string) => void;
    onNavigate: (input: string) => void;
  }

  let { files, hosts, t, onHostChange, onOpenDir, onNavigate }: Props = $props();

  // `files` is the panel's data; naming it twice keeps the callbacks readable.
  const filesDock = $derived(files);
  const downloadable = $derived(files.selectedEntries.filter((entry) => !entry.dir).length);
  const selectedDirs = $derived(files.selectedEntries.filter((entry) => entry.dir).length);
  const selectedCount = $derived(files.selectedEntries.length);
  const uploading = $derived(files.upload);
  const percent = $derived(
    uploading && uploading.total > 0 ? Math.min(100, Math.round((uploading.sent / uploading.total) * 100)) : 0,
  );

  /**
   * A column edge being dragged.
   *
   * ⚠ THE HANDLE REPORTS A DELTA FROM WHERE THE GESTURE STARTED, so the delta is added
   * to the width the gesture STARTED from. Adding it to the current width compounds
   * every pointer move into a runaway column — the same latch `+page.svelte` keeps for
   * the dock and the sidebar, for the same measured reason.
   */
  let columnBase: number | null = null;
  function dragColumn(key: FsColumnKey, delta: number, commit: boolean, panelWidth: number): void {
    columnBase ??= files.columns[key];
    files.resizeColumn(key, columnBase + delta, panelWidth);
    if (commit) columnBase = null;
  }

  let picker = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let confirmOpen = $state(false);
  const names = $derived(
    files.selectedEntries
      .slice(0, 5)
      .map((entry) => entry.name + (entry.dir ? "/" : ""))
      .join(", ") + (selectedCount > 5 ? ` +${selectedCount - 5}` : ""),
  );

  function send(list: FileList | null): void {
    const chosen = [...(list ?? [])];
    if (chosen.length) void files.uploadFiles(chosen, () => onOpenDir(files.path));
  }

  /**
   * ⚠ `dragover` MUST BE CANCELLED OR THE DROP NEVER FIRES — and the browser
   * navigates to the file instead, throwing the dashboard away. That is the whole
   * reason this handler exists; the highlight is a side effect.
   */
  function onDragOver(event: DragEvent): void {
    if (!files.hostId) return;
    event.preventDefault();
    dragging = true;
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    if (!files.hostId) return;
    // ⚠ ONLY FILES. A folder dropped from Finder or Explorer arrives as an entry
    // with no contents here, and uploading it as a zero-byte file of the same
    // name would be worse than refusing.
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length) void files.uploadFiles(dropped, () => onOpenDir(files.path));
  }

  function confirmDelete(): void {
    void files.removeSelected(true).then((error) => {
      if (error) toast.error(error);
      onOpenDir(files.path);
    });
  }

  const i18n = getI18n();

  /**
   * When a listing was last written.
   *
   * ⚠ A LOCALE FORMAT, WHICH IS WHY IT IS HERE AND NOT IN `@pdmux/ui`. That package
   * takes `formatDate` as a prop for exactly this reason — `time.ts` records it: a
   * package that formats a date owns a string its consumer cannot localise. Same
   * arrangement `commit-dock` already has with the graph.
   *
   * Two digits everywhere and no seconds: the column is ~116px of 11px monospace, and
   * `commit-dock` learned what happens when a timestamp does not fit — it wrapped
   * inside a fixed-height row and covered the row beneath it.
   */
  const listingStamp = new Intl.DateTimeFormat(i18n.locale, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const listingDate = (epochSeconds: number): string => listingStamp.format(new Date(epochSeconds * 1000));

  const hostName = $derived(hosts.find((host) => host.id === files.hostId)?.label ?? i18n.t.dash.files.pickHost);

  /**
   * The home as the user would write it. The agent sends its absolute home for
   * display; an agent too old to say gets `~`, which is still true.
   */
  const home = $derived(files.dir?.home || "~");

  /** The full path, spelled the way `pwd` would spell it. */
  const fullPath = $derived(files.path ? `${home}/${files.path}` : home);

  const crumbs = $derived.by(() => {
    const out = [{ label: home, path: "" }];
    let walked = "";
    for (const segment of files.path.split("/").filter(Boolean)) {
      walked = walked ? `${walked}/${segment}` : segment;
      out.push({ label: segment, path: walked });
    }
    return out;
  });

  /**
   * ⚠ THE FIELD IS A MODE, NOT A PERMANENT INPUT. A dock column is ~420px, and an
   * always-editable path field costs the row the crumbs need — while the crumbs are
   * what people use nine times out of ten. Typing is the exception, so it asks.
   */
  let editing = $state(false);
  let draft = $state("");

  function startEditing(): void {
    draft = fullPath;
    editing = true;
  }

  function commitPath(): void {
    editing = false;
    onNavigate(draft);
  }

  /**
   * Hand each selected file to the browser as a download.
   *
   * ⚠ ONE ANCHOR CLICK PER FILE, NOT AN ARCHIVE. Zipping would mean the server
   * buffering a whole selection to produce one stream, and the moment it does
   * that, progress and resume — the two things the offset transfer bought — are
   * gone. Several downloads is what the browser is good at.
   *
   * ⚠ AND THEY ARE SPACED OUT. Fired in one tick, Chrome treats the burst as a
   * pop-up flood and silently drops all but the first.
   */
  function downloadSelected(): void {
    const files = filesDock.downloadUrls();
    files.forEach((file, index) => {
      setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = file.url;
        // The server sets `Content-Disposition`, which wins; this is the fallback
        // for the case where it did not answer at all.
        anchor.download = file.name;
        anchor.rel = "noopener";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }, index * 300);
    });
  }

  function onPathKey(event: KeyboardEvent): void {
    if (event.key === "Enter") commitPath();
    else if (event.key === "Escape") editing = false;
  }
</script>

<!-- ⚠ THE DROP TARGET IS THE WHOLE PANEL, not the listing. A person dragging a
     file aims at the area, and a target that only covers the rows makes a drop
     onto the empty space below them navigate the browser away from the app. -->
<div
  class="pdmux pdmux-files-dock"
  data-pdmux-region="files"
  data-testid="files-dock"
  data-pdmux-dragging={dragging ? "true" : undefined}
  role="region"
  aria-label={i18n.t.dash.files.pathLabel}
  ondragover={onDragOver}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <header class="flex items-center gap-2 border-b px-2 py-1.5 text-xs">
    <Select.Root
      type="single"
      value={files.hostId ?? ""}
      onValueChange={(value: string) => onHostChange(value)}
    >
      <Select.Trigger class="h-7 flex-1 text-xs" data-testid="files-host">{hostName}</Select.Trigger>
      <Select.Content>
        {#each hosts as host (host.id)}
          <Select.Item value={host.id}>{host.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <!-- The toolbar. Actions sit beside the host picker, and each is disabled
         rather than hidden when the selection cannot answer it — a control that
         appears and disappears as rows are clicked is harder to aim at. -->
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={!files.hostId || uploading !== null}
      title={i18n.t.dash.files.upload}
      aria-label={i18n.t.dash.files.upload}
      data-testid="files-upload"
      onclick={() => picker?.click()}><UploadIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={downloadable === 0}
      title={fmt(i18n.t.dash.files.download, { count: String(downloadable) })}
      aria-label={i18n.t.dash.files.downloadLabel}
      data-testid="files-download"
      onclick={downloadSelected}><DownloadIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={!files.hostId || files.loading}
      title={i18n.t.dash.files.refresh}
      aria-label={i18n.t.dash.files.refresh}
      data-testid="files-refresh"
      onclick={() => void files.refresh()}><RefreshCwIcon class="size-4" /></Button
    >
    <!-- ⚠ DESTRUCTIVE, AND IT LOOKS IT. It is also the only control here that
         cannot act without a second, explicit yes. -->
    <Button
      variant="ghost"
      size="sm"
      class="text-destructive hover:text-destructive h-7 px-2"
      disabled={selectedCount === 0}
      title={i18n.t.dash.files.delete}
      aria-label={i18n.t.dash.files.delete}
      data-testid="files-delete"
      onclick={() => (confirmOpen = true)}><Trash2Icon class="size-4" /></Button
    >
    <input
      bind:this={picker}
      class="hidden"
      type="file"
      multiple
      data-testid="files-picker"
      onchange={(event: Event) => {
        send((event.currentTarget as HTMLInputElement).files);
        (event.currentTarget as HTMLInputElement).value = "";
      }}
    />
  </header>

  {#if files.hostId}
    <div class="flex items-center gap-1 border-b px-2 py-1" data-pdmux-files-pathbar>
      {#if editing}
        <!-- ⚠ PASTING A PATH IS THE POINT. People copy what `pwd` printed, so an
             absolute path is READ, not refused — the fence is the agent's root
             handle, never a string check here. -->
        <Input
          class="h-7 flex-1 font-mono text-xs"
          bind:value={draft}
          autofocus
          spellcheck={false}
          aria-label={i18n.t.dash.files.pathLabel}
          data-testid="files-path-input"
          onkeydown={onPathKey}
          onblur={() => (editing = false)}
        />
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-2"
          title={i18n.t.dash.files.go}
          aria-label={i18n.t.dash.files.go}
          data-testid="files-path-go"
          onmousedown={(event: MouseEvent) => event.preventDefault()}
          onclick={commitPath}><CheckIcon class="size-4" /></Button
        >
      {:else}
        <nav
          class="pdmux-files-crumbs"
          data-pdmux-files-crumbs
          aria-label={i18n.t.dash.files.pathLabel}
          title={fullPath}
        >
          {#each crumbs as crumb, index (crumb.path)}
            {#if index > 0}<span class="pdmux-files-sep" aria-hidden="true">/</span>{/if}
            <button
              class="pdmux-files-crumb"
              type="button"
              data-pdmux-crumb={crumb.path}
              aria-current={crumb.path === files.path ? "location" : undefined}
              onclick={() => onOpenDir(crumb.path)}>{crumb.label}</button
            >
          {/each}
        </nav>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 px-2"
          title={i18n.t.dash.files.editPath}
          aria-label={i18n.t.dash.files.editPath}
          data-testid="files-path-edit"
          onclick={startEditing}><PencilIcon class="size-4" /></Button
        >
      {/if}
    </div>
  {/if}

  <FileExplorer
    dir={files.shown}
    path={files.path}
    loading={files.loading}
    unavailable={files.unavailable}
    idle={!files.hostId}
    selected={files.selected}
    file={files.file}
    fileLoading={files.fileLoading}
    image={files.image}
    sort={files.sort}
    columns={files.columns}
    scheme={colourScheme.current === "dark" ? "dark" : "light"}
    formatDate={listingDate}
    {t}
    onOpenDir={(path: string) => onOpenDir(path)}
    onSelect={(name: string, mode: SelectMode) => files.select(name, mode)}
    onClosePreview={() => files.closePreview()}
    onSort={(key: FsSortKey) => files.sortBy(key)}
    onColumnResize={dragColumn}
  />

  {#if uploading}
    <!-- Progress belongs where the file is going, not in a corner toast: the
         percentage and the name answer "is this still moving" at a glance. -->
    <div class="pdmux-files-upload" data-testid="files-progress" data-pdmux-upload-error={uploading.error ? "true" : undefined}>
      <div class="flex items-center gap-2">
        <span class="truncate">{uploading.name}</span>
        <span class="text-muted-foreground ml-auto shrink-0 tabular-nums">
          {uploading.error ? "" : `${percent}%`}
          {#if uploading.queued > 0}{fmt(i18n.t.dash.files.queued, { count: String(uploading.queued) })}{/if}
        </span>
      </div>
      {#if uploading.error}
        <p class="text-destructive" data-testid="files-upload-error">{uploading.error}</p>
      {:else}
        <div class="pdmux-files-bar"><div class="pdmux-files-bar-fill" style:width={`${percent}%`}></div></div>
      {/if}
    </div>
  {/if}
</div>

<!--
  ⚠ DELETING ALWAYS ASKS, AND THE QUESTION NAMES WHAT GOES. A count is not a
  question — "delete 4 items" reads the same whether they are scratch files or a
  directory somebody spent a week on — so the dialog lists the names and says
  plainly that a folder takes its contents with it.
-->
<ConfirmDialog
  bind:open={confirmOpen}
  title={i18n.t.dash.files.deleteTitle}
  warning={selectedDirs > 0
    ? fmt(i18n.t.dash.files.deleteFolderWarning, { names: names, count: String(selectedCount) })
    : fmt(i18n.t.dash.files.deleteWarning, { names: names, count: String(selectedCount) })}
  confirmLabel={i18n.t.dash.files.deleteConfirm}
  testId="files-delete-confirm"
  onConfirm={confirmDelete}
/>

<style>
  /* The panel fills its half of the dock column; the listing inside it scrolls. */
  .pdmux-files-dock {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    background: var(--pdmux-card);
  }
</style>
