<script lang="ts">
  /**
   * The file explorer's controls: which host, where in it, and what to do there.
   *
   * ⚠ THE CONTROLS ARE HERE AND THE LISTING IS IN `@pdmux/ui` — the split
   * `ui-changes.md` records. The package cannot use shadcn, so a select or a
   * toolbar built inside it comes out as a look-alike beside real ones; and the
   * package may not fetch (`[TC-PDUI-030]`), so the network belongs here too.
   */
  import { type CheckMode, FileExplorer, type SelectMode, type Translate } from "@pdmux/ui";
  import type { FsColumnKey, FsSortKey } from "@pdmux/core";
  import { mode as colourScheme } from "mode-watcher";
  import CheckIcon from "@lucide/svelte/icons/check";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import FolderUpIcon from "@lucide/svelte/icons/folder-up";
  import { FILE_TRANSFER_CAPABILITY } from "@pdmux/protocol/transfer-limits";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import XIcon from "@lucide/svelte/icons/x";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { toast } from "svelte-sonner";
  import { filesApi } from "../api";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import type { FilesDock, FileDeleteTarget, FileDeleteResult } from "../files-dock.svelte";
  import type { HostView } from "../types";
  import ConfirmDialog from "./confirm-dialog.svelte";
  import FileTransferPanel from "./file-transfer-panel.svelte";
  import FilePreviewPane from "./file-preview.svelte";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import { canPickFolder, captureDrop, pickFolder, sourceFromDroppedEntries, sourceFromFiles } from "../file-transfers/source";

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
  const folderTransfers = $derived(hosts.find((host) => host.id === files.hostId)?.capabilities.includes(FILE_TRANSFER_CAPABILITY) ?? false);
  const downloadable = $derived(folderTransfers ? files.selectedEntries.length : files.selectedEntries.filter((entry) => !entry.dir).length);
  const selectedDirs = $derived(files.selectedEntries.filter((entry) => entry.dir).length);
  const selectedCount = $derived(files.selectedEntries.length);
  const uploading = $derived(files.upload);
  $effect(() => {
    if (files.hostId && folderTransfers) void files.transfers.load(files.hostId);
  });

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
  let deleteTarget = $state<FileDeleteTarget | null>(null);
  let deleteResult = $state<FileDeleteResult | null>(null);
  let previewMode = $state("preview");
  $effect(() => { files.preview?.path; previewMode = "preview"; });
  let panel = $state<HTMLDivElement | null>(null);
  const names = $derived.by(() => {
    const entries = deleteTarget?.entries ?? files.selectedEntries;
    return entries.slice(0, 5).map((entry) => entry.name + (entry.dir ? "/" : "")).join(", ")
      + (entries.length > 5 ? ` +${entries.length - 5}` : "");
  });

  function send(list: FileList | null): void {
    const chosen = [...(list ?? [])];
    if (!chosen.length || !files.hostId) return;
    if (folderTransfers) void files.transfers.prepare(files.hostId, files.path, (progress) => sourceFromFiles(chosen, progress));
    else void files.uploadFiles(chosen, () => onOpenDir(files.path));
  }

  function uploadFolder(): void {
    if (files.hostId && folderTransfers) void files.transfers.prepare(files.hostId, files.path, pickFolder);
  }

  /**
   * Escape drops the selection while focus is anywhere in the panel.
   *
   * ⚠ NOT FROM A TEXT FIELD. Escape in the path field already means "stop editing", and a
   * key that also threw the selection away would cost the person the thing they were
   * about to act on. Attached here rather than as `onkeydown` in the markup because the
   * panel is a landmark, not a control — the listener only hears what bubbles from the
   * controls inside it.
   */
  function onPanelKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && event.target instanceof Element && event.target.closest("[data-pdmux-files-body]")) {
      event.preventDefault();
      files.setSelection((files.shown?.entries ?? []).map((entry) => entry.name));
      return;
    }
    if (event.key !== "Escape" || files.selected.length === 0) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    event.preventDefault();
    files.clearSelection();
  }

  $effect(() => {
    const node = panel;
    if (!node) return;
    node.addEventListener("keydown", onPanelKey);
    return () => node.removeEventListener("keydown", onPanelKey);
  });

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
    if (!event.dataTransfer) return;
    const dropped = captureDrop(event.dataTransfer);
    if (folderTransfers) {
      void files.transfers.prepare(files.hostId, files.path, (progress) => dropped.entries.length
        ? sourceFromDroppedEntries(dropped.entries, progress)
        : sourceFromFiles(dropped.files, progress));
    } else if (dropped.entries.some((entry) => entry.isDirectory)) {
      toast.error(i18n.t.dash.files.transfers.upgrade);
    } else if (dropped.files.length) {
      void files.uploadFiles(dropped.files, () => onOpenDir(files.path));
    }
  }

  function askDelete(): void {
    deleteTarget = files.selectionTarget();
    deleteResult = null;
    confirmOpen = deleteTarget !== null && deleteTarget.entries.length > 0;
  }
  async function confirmDelete(): Promise<boolean> {
    const target = deleteTarget;
    if (!target) return true;
    const result = await files.removeSelected(true, target);
    deleteResult = result;
    const remaining = new Set([...result.failed.map((value) => value.name), ...result.pending]);
    deleteTarget = { ...target, entries: target.entries.filter((entry) => remaining.has(entry.name)) };
    if (files.hostId === target.hostId && files.path === target.basePath) await files.refresh();
    return remaining.size === 0;
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

  /** Single files retain their original format; folders and mixed selections use ZIP. */
  function downloadSelected(): void {
    if (folderTransfers && filesDock.hostId && (selectedDirs > 0 || selectedCount > 1)) {
      void filesDock.transfers.download(filesDock.hostId, filesDock.path, [...filesDock.selected]);
      return;
    }
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
  bind:this={panel}
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
  <!-- `@container`: the toolbar sizes the selection count by its OWN width (see below). -->
  <header class="@container flex items-center gap-2 border-b px-2 py-1.5 text-xs">
    <Select.Root
      type="single"
      value={files.hostId ?? ""}
      onValueChange={(value: string) => onHostChange(value)}
    >
      <Select.Trigger class="h-7 min-w-0 flex-1 text-xs" data-testid="files-host"><span class="truncate">{hostName}</span></Select.Trigger>
      <Select.Content>
        {#each hosts as host (host.id)}
          <Select.Item value={host.id}>{host.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <!-- The toolbar. Actions sit beside the host picker, and each is disabled
         rather than hidden when the selection cannot answer it — a control that
         appears and disappears as rows are clicked is harder to aim at.

         ⚠ THE SELECTION COUNT IS THE ONE EXCEPTION, AND IT SITS LEFT OF THE ACTIONS SO
         IT CANNOT MOVE THEM: the host picker gives up the room. It says how many are
         chosen in THIS directory, and it is gone the moment the panel opens another —
         the selection does not travel, and a count that lingered would say it did.

         ⚠ AND ON A NARROW TOOLBAR IT IS THE NUMBER ALONE. The words took the host picker
         to 64px ("T…") on a 390px phone. The five actions, their gaps and the clear button
         spend about 250px and "N selected" another 60, so below a 420px toolbar the words
         would leave the picker under 100px. Decided by a container query on this header —
         the dock's own width, not the viewport's: one viewport holds a 440px dock and a
         full-width phone view. The words stay the title and the screen-reader text. -->
    {#if selectedCount > 0}
      {@const summary = fmt(i18n.t.dash.files.selectedCount, { count: String(selectedCount) })}
      <div class="flex shrink-0 items-center" data-testid="files-selection">
        <span
          class="text-muted-foreground tabular-nums whitespace-nowrap"
          role="status"
          title={summary}
          data-testid="files-selection-count"
        >
          <span class="sr-only">{summary}</span>
          <span class="hidden @min-[420px]:inline" aria-hidden="true" data-pdmux-count="full">{summary}</span>
          <span class="@min-[420px]:hidden" aria-hidden="true" data-pdmux-count="short">{selectedCount}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-1.5"
          title={i18n.t.dash.files.clearSelection}
          aria-label={i18n.t.dash.files.clearSelection}
          data-testid="files-clear-selection"
          onclick={() => files.clearSelection()}><XIcon class="size-4" /></Button
        >
      </div>
    {/if}
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={!files.hostId || uploading !== null || files.transfers.preparing !== null}
      title={i18n.t.dash.files.upload}
      aria-label={i18n.t.dash.files.upload}
      data-testid="files-upload"
      onclick={() => picker?.click()}><UploadIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={!folderTransfers || !canPickFolder() || files.transfers.preparing !== null}
      title={!folderTransfers ? i18n.t.dash.files.transfers.upgrade : i18n.t.dash.files.transfers.folderUnavailable}
      aria-label={i18n.t.dash.files.transfers.uploadFolder}
      data-testid="files-upload-folder"
      onclick={uploadFolder}><FolderUpIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2"
      disabled={downloadable === 0 || (!folderTransfers && selectedDirs > 0) || files.transfers.startingDownload}
      title={!folderTransfers && selectedDirs > 0 ? i18n.t.dash.files.transfers.upgrade : fmt(i18n.t.dash.files.download, { count: String(downloadable) })}
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
      onclick={askDelete}><Trash2Icon class="size-4" /></Button
    >
    <Input
      bind:ref={picker}
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

  {#if files.hostId && (!folderTransfers || !canPickFolder())}
    <p class="text-muted-foreground shrink-0 border-b px-2 py-1 text-xs">
      {!folderTransfers ? i18n.t.dash.files.transfers.upgrade : i18n.t.dash.files.transfers.folderUnavailable}
    </p>
  {/if}
  {#snippet previewHeader()}
    {#if files.preview?.kind === "markdown"}
      <Tabs.List class="h-7"><Tabs.Trigger value="preview" class="px-2 text-xs">{i18n.t.dash.files.preview.rendered}</Tabs.Trigger><Tabs.Trigger value="source" class="px-2 text-xs">{i18n.t.dash.files.preview.source}</Tabs.Trigger></Tabs.List>
    {/if}
    {#if files.preview && files.hostId}<Button variant="ghost" size="icon" class="size-7 shrink-0" href={filesApi.url(files.hostId, files.preview.path)} aria-label={i18n.t.dash.files.downloadLabel}><DownloadIcon class="size-4" /></Button>{/if}
  {/snippet}
  {#snippet previewContent()}
    {#if files.preview && files.hostId}
      {#key `${files.hostId}:${files.preview.path}`}
        {#if files.preview.kind === "markdown"}
          <Tabs.Content value="preview" class="m-0"><FilePreviewPane preview={files.preview} file={files.file} loading={files.fileLoading} mode="preview" hostId={files.hostId} {t} onOpenFile={(path) => void files.openFile(path)} /></Tabs.Content>
          <Tabs.Content value="source" class="m-0"><FilePreviewPane preview={files.preview} file={files.file} loading={files.fileLoading} mode="source" hostId={files.hostId} {t} onOpenFile={(path) => void files.openFile(path)} /></Tabs.Content>
        {:else}
          <FilePreviewPane preview={files.preview} file={files.file} loading={files.fileLoading} mode={previewMode} hostId={files.hostId} {t} onOpenFile={(path) => void files.openFile(path)} />
        {/if}
      {/key}
    {/if}
  {/snippet}
  <Tabs.Root bind:value={previewMode} class="contents">
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
    previewPath={files.preview?.path ?? null}
    {previewHeader}
    {previewContent}
    sort={files.sort}
    columns={files.columns}
    scheme={colourScheme.current === "dark" ? "dark" : "light"}
    formatDate={listingDate}
    {t}
    selectable
    {onOpenDir}
    onSelect={(name: string, mode: SelectMode) => files.select(name, mode)}
    onCheck={(name: string, mode: CheckMode) => files.check(name, mode)}
    onCheckAll={(names: string[]) => files.setSelection(names)}
    onClosePreview={() => files.closePreview()}
    onSort={(key: FsSortKey) => files.sortBy(key)}
    onColumnResize={dragColumn}
  />
  </Tabs.Root>

  <FileTransferPanel transfers={files.transfers} legacyUpload={uploading} hostLabel={(id) => hosts.find((host) => host.id === id)?.label ?? id} />
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
  warning={(deleteTarget?.entries.some((entry) => entry.dir) ?? selectedDirs > 0)
    ? fmt(i18n.t.dash.files.deleteFolderWarning, { names: names, count: String(deleteTarget?.entries.length ?? selectedCount) })
    : fmt(i18n.t.dash.files.deleteWarning, { names: names, count: String(deleteTarget?.entries.length ?? selectedCount) })}
  confirmLabel={i18n.t.dash.files.deleteConfirm}
  testId="files-delete-confirm"
  onConfirm={confirmDelete}
>
  {#snippet details()}
    {#if deleteResult}
      <p role="status">{fmt(i18n.t.dash.files.deleteResult, { done: String(deleteResult.removed.length), failed: String(deleteResult.failed.length), pending: String(deleteResult.pending.length) })}</p>
      {#each deleteResult.failed as entry}<p class="break-all text-destructive">{entry.name}: {entry.error}</p>{/each}
    {/if}
    {#each deleteTarget?.entries ?? [] as entry}<p class="break-all">{entry.name}{entry.dir ? "/" : ""}</p>{/each}
  {/snippet}
</ConfirmDialog>

<style>
  /* The panel fills its half of the dock column; the listing inside it scrolls.
     `min-width: 0` because the toolbar's widest moment (a selection count beside five
     actions) is wider than a 390px phone: placed in a row, the panel would grow to its
     toolbar and push past the screen (measured 421px) instead of letting the host picker
     give up the room. */
  .pdmux-files-dock {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--pdmux-card);
  }
</style>
