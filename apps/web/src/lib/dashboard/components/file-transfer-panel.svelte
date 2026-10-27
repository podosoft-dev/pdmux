<script lang="ts">
  import { humanSize } from "@pdmux/core";
  import type { FileTransferView } from "@pdmux/protocol";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import DataTable from "#lib/components/data-table.svelte";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import type { FileTransferController } from "../file-transfers/controller.svelte";
  import { captureDrop, pickFolder, sourceFromDroppedEntries, sourceFromFiles } from "../file-transfers/source";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import ArrowDownUpIcon from "@lucide/svelte/icons/arrow-down-up";
  import type { FilesDock } from "../files-dock.svelte";
  import TimerIcon from "@lucide/svelte/icons/timer";

  let { transfers, hostLabel, legacyUpload = null }: { transfers: FileTransferController; hostLabel: (id: string) => string; legacyUpload?: FilesDock["upload"] } = $props();
  const i18n = getI18n();
  const messages = $derived(i18n.t.dash.files.transfers);
  let all = $state(false);
  let view = $state("current");
  const panelId = $props.id();
  const active = $derived(transfers.jobs.filter((job) => transfers.group(job) === "active").length + (transfers.preparing ? 1 : 0) + (legacyUpload && !legacyUpload.error ? 1 : 0));
  const attention = $derived(transfers.jobs.filter((job) => transfers.group(job) === "attention").length + (transfers.error ? 1 : 0) + (legacyUpload?.error ? 1 : 0));
  const history = $derived(transfers.jobs.filter((job) => transfers.group(job) === "history"));
  const visible = $derived(transfers.jobs.filter((job) => view === "history" ? transfers.group(job) === "history" : transfers.group(job) !== "history"));
  function openDetails(): void { view = active || attention ? "current" : "history"; transfers.expanded = true; }
  let reselect = $state<FileTransferView | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  const conflict = $derived(transfers.conflict);
  const finished = $derived(transfers.jobs.filter((job) => ["completed", "cancelled", "expired"].includes(job.state)));
  const columns = $derived([{ key: "created", label: messages.title, sortable: true, class: "w-full" }]);

  const reasons = $derived<Record<string, string>>({
    FILES_TRANSFER_CLEAR_FAILED: messages.clearError,
    FILES_TRANSFER_SOURCE_CHANGED: messages.sourceChanged,
    FILES_TRANSFER_LIMIT: messages.limit,
    FILES_TRANSFER_DISK_FULL: messages.diskFull,
    FILES_TRANSFER_PICKER_UNSUPPORTED: messages.pickerUnsupported,
    HOST_FILES_TRANSFER_UNSUPPORTED: messages.upgrade,
    FILES_TRANSFER_RESELECT: messages.reselect,
    FILES_TRANSFER_EXCLUDED: messages.excluded,
  });
  function reason(code: string): string { return reasons[code] ?? messages.genericError; }
  function resume(job: FileTransferView): void {
    if (job.direction === "download" || transfers.hasSource(job.id)) void transfers.resume(job);
    else reselect = job;
  }
  function selectFolder(): void {
    const job = reselect;
    if (!job) return;
    reselect = null;
    void transfers.prepare(job.hostId, job.basePath, pickFolder, job);
  }
  function selectFiles(event: Event): void {
    const job = reselect;
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    reselect = null;
    if (job && files.length) void transfers.prepare(job.hostId, job.basePath, (progress) => sourceFromFiles(files, progress), job);
  }
  // Drives the countdown of uploads waiting out a refused request; idle otherwise.
  let now = $state(Date.now());
  $effect(() => {
    if (Object.keys(transfers.retrying).length === 0) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 250);
    return () => clearInterval(timer);
  });
  function retrySeconds(at: number): string {
    return String(Math.max(1, Math.ceil((at - now) / 1000)));
  }
  function percent(job: FileTransferView): number | null {
    if (!job.totalEntries) return null;
    if (!job.totalBytes) return job.completedEntries / job.totalEntries * 100;
    return Math.min(100, job.bytes / job.totalBytes * 100);
  }
  function reselectDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const job = reselect;
    if (!job || !event.dataTransfer) return;
    const dropped = captureDrop(event.dataTransfer);
    reselect = null;
    void transfers.prepare(job.hostId, job.basePath, (progress) => dropped.entries.length
      ? sourceFromDroppedEntries(dropped.entries, progress) : sourceFromFiles(dropped.files, progress), job);
  }
</script>

{#snippet failureCode(code: string)}
  <!-- The generic sentence cannot say what failed; the code is what a report needs (#30). -->
  {#if !(code in reasons)}<p class="text-muted-foreground font-mono text-[0.6875rem] break-all" data-testid="transfer-error-code">{fmt(messages.errorCode, { code })}</p>{/if}
{/snippet}

{#if transfers.jobs.length || transfers.preparing || transfers.error || legacyUpload}
  <section class="h-9 shrink-0 border-t text-xs" data-testid="file-transfer-panel" aria-label={messages.title}>
    <Button variant="ghost" class="h-9 w-full min-w-0 justify-between gap-2 rounded-none px-2 text-xs" onclick={openDetails} data-testid="transfers-summary" aria-haspopup="dialog">
      <span class="flex shrink-0 items-center gap-1"><ArrowDownUpIcon class="size-3.5" />{messages.title}</span>
      <span class="truncate" class:text-destructive={attention > 0} role="status">{active || attention ? fmt(messages.summary, { active: String(active), attention: String(attention) }) : fmt(messages.historySummary, { count: String(history.length) })}</span>
    </Button>
  </section>
{/if}

<Dialog.Root bind:open={transfers.expanded}>
  <Dialog.Content class="flex max-h-[85dvh] w-[calc(100vw-2rem)] sm:w-[min(48rem,calc(100vw-2rem))] max-w-3xl sm:max-w-3xl min-h-0 flex-col gap-3 overflow-hidden" data-testid="transfers-dialog">
    <Dialog.Header class="shrink-0 pr-6"><Dialog.Title>{messages.title}</Dialog.Title><Dialog.Description>{messages.retention}</Dialog.Description></Dialog.Header>
    <Tabs.Root bind:value={view} class="min-h-0 flex-1 flex flex-col">
      <Tabs.List class="shrink-0 grid w-full grid-cols-2"><Tabs.Trigger id={`${panelId}-current`} aria-controls={panelId} value="current" class="min-w-0 px-1 text-xs sm:text-sm"><span class="truncate" title={messages.current}>{messages.current}</span><span class="shrink-0">({active + attention})</span></Tabs.Trigger><Tabs.Trigger id={`${panelId}-history`} aria-controls={panelId} value="history" class="min-w-0 px-1 text-xs sm:text-sm">{messages.history} ({history.length})</Tabs.Trigger></Tabs.List>
      <div class="min-h-0 flex-1 overflow-y-auto" id={panelId} role="tabpanel" tabindex="0" aria-labelledby={`${panelId}-${view}`} data-testid="transfer-list">
        {#if view === "current"}
        {#if transfers.error}<div class="px-2 py-1" role="alert"><p class="text-destructive break-words">{reason(transfers.error)}</p>{@render failureCode(transfers.error)}</div>{/if}
        {#if transfers.preparing}
          {@const preparation = transfers.preparing}
          <div class="space-y-1 px-2 py-1" data-testid="transfer-preparation">
            <p>{preparation.phase === "scanning" ? messages.scanning : messages.hashing} · {preparation.count}</p>
            <p class="truncate">{preparation.path}</p>
            <Progress value={preparation.phase === "scanning" || !preparation.totalBytes ? null : preparation.bytes / preparation.totalBytes * 100} aria-label={messages.hashing} />
            <Button size="sm" variant="outline" onclick={() => transfers.cancelPreparation()}>{messages.cancelPreparation}</Button>
          </div>
        {/if}
        {#if legacyUpload}
          <div class="space-y-1 px-2 py-2" data-testid="files-progress">
            <p class="truncate">{legacyUpload.name}</p>
            <Progress value={legacyUpload.total ? legacyUpload.sent / legacyUpload.total * 100 : null} aria-label={messages.uploading} />
            {#if legacyUpload.error}<p class="text-destructive break-words" data-testid="files-upload-error">{legacyUpload.error}</p>{/if}
          </div>
        {/if}
        {/if}
        {#if view === "history" && finished.length}<Button variant="outline" size="sm" class="my-2" disabled={transfers.removing.length > 0} onclick={() => void transfers.removeFinished()}>{messages.clearAll}</Button>{/if}
        {#if visible.length}
          <DataTable rows={visible} {columns} getKey={(job) => job.id} empty={messages.empty} ariaLabel={messages.title}>
            {#snippet row(job)}
              <Table.Cell class="max-w-0 whitespace-normal px-2 py-2">
                <div class="space-y-1" data-testid="transfer-job" data-transfer-id={job.id} data-transfer-state={job.state}>
                  <p class="truncate" title={job.basePath}>{hostLabel(job.hostId)} · ~/{job.basePath}</p>
                  {#if transfers.retrying[job.id] !== undefined}
                    <p class="flex flex-wrap items-center gap-1 font-medium" data-testid="transfer-retry">
                      <TimerIcon class="size-3.5 shrink-0" aria-hidden="true" />
                      <span role="status">{messages.retrying}</span>
                      <span class="tabular-nums" aria-hidden="true">· {fmt(messages.retryIn, { seconds: retrySeconds(transfers.retrying[job.id] ?? now) })}</span>
                      <span class="text-muted-foreground">· {messages.uploading}</span>
                    </p>
                  {:else}
                    <p class="text-muted-foreground">{messages.states[job.state]} · {job.direction === "upload" ? messages.uploading : messages.downloading}</p>
                  {/if}
                  <p class="truncate" title={job.currentPath}>{job.currentPath}</p>
                  <Progress value={percent(job)} aria-label={messages.states[job.state]} />
                  <p class="flex flex-wrap justify-between gap-1 tabular-nums">
                    <span>{humanSize(job.bytes)} / {humanSize(job.totalBytes)}</span>
                    <span>{fmt(messages.count, { done: String(job.completedEntries), total: String(job.totalEntries) })}</span>
                  </p>
                  {#if job.errorCode}<p class="text-destructive break-words">{reason(job.errorCode)}</p>{@render failureCode(job.errorCode)}{/if}
                  {#if job.exclusions.length}
                    <p>{messages.excluded}</p>
                    <pre class="max-h-20 overflow-auto whitespace-pre-wrap break-all">{job.exclusions.join("\n")}</pre>
                  {/if}
                  <div class="flex flex-wrap gap-1">
                    {#if ["running", "queued"].includes(job.state)}
                      <Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => void transfers.pause(job)}>{messages.pause}</Button>
                    {/if}
                    {#if ["paused", "failed", "draft"].includes(job.state) || (job.direction === "upload" && job.state === "running" && !transfers.hasSource(job.id))}
                      <Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => resume(job)}>{messages.resume}</Button>
                    {/if}
                    {#if job.state === "ready"}
                      <Button size="sm" class="h-7 text-xs" disabled={transfers.saving.includes(job.id)} onclick={() => void transfers.save(job)}>{messages.save}</Button>
                    {/if}
                    {#if !["completed", "cancelled", "expired"].includes(job.state)}
                      <Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => void transfers.cancel(job)}>{messages.cancel}</Button>
                    {:else}
                      <Button variant="ghost" size="sm" class="h-7 text-xs" disabled={transfers.removing.includes(job.id)} aria-label={fmt(messages.clearOne, { path: job.basePath || job.currentPath || hostLabel(job.hostId) })} onclick={() => void transfers.remove(job)}>{messages.clear}</Button>
                    {/if}
                  </div>
                  {#if transfers.nativeDownloads[job.id]}
                    {@const download = transfers.nativeDownloads[job.id]}
                    {#if download}
                      <p>{download.state === "completed" ? messages.nativeComplete : messages.nativeTitle}</p>
                      <Progress value={download.total ? download.received / download.total * 100 : null} aria-label={messages.nativeTitle} />
                      <p class="tabular-nums">{humanSize(download.received)} / {humanSize(download.total)}</p>
                      {#if download.state !== "completed"}
                        <div class="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" onclick={() => void transfers.save(job)}>{messages.nativeResume}</Button>
                          <Button size="sm" variant="outline" onclick={() => void transfers.pauseDownload(job)}>{messages.pause}</Button>
                          <Button size="sm" variant="ghost" onclick={() => void transfers.cancelDownload(job)}>{messages.cancel}</Button>
                        </div>
                      {/if}
                    {/if}
                  {:else if transfers.handedOff.includes(job.id)}
                    <p class="text-muted-foreground">{messages.handedOff}</p>
                  {/if}
                </div>
              </Table.Cell>
            {/snippet}
          </DataTable>
        {/if}
        {#if !visible.length && !(view === "current" && (transfers.preparing || transfers.error || legacyUpload))}<p class="p-3 text-sm text-muted-foreground">{messages.empty}</p>{/if}
      </div>
    </Tabs.Root>
    <Dialog.Footer class="shrink-0"><Button variant="outline" onclick={() => transfers.expanded = false}>{messages.close}</Button></Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={conflict !== null} onOpenChange={(open) => { if (!open) transfers.choose("cancel"); }}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto" data-testid="transfer-conflict">
    <Dialog.Header>
      <Dialog.Title>{messages.conflictTitle}</Dialog.Title>
      <Dialog.Description class="break-all">{fmt(messages.conflict, { path: conflict?.path ?? "" })}</Dialog.Description>
    </Dialog.Header>
    {#if conflict?.typeConflict}<p>{messages.typeConflict}</p>{/if}
    <div class="flex items-center gap-2"><Checkbox id="transfer-conflict-all" bind:checked={all} /><Label for="transfer-conflict-all">{messages.applyAll}</Label></div>
    <Dialog.Footer class="flex-wrap">
      <Button variant="outline" onclick={() => transfers.choose("cancel")}>{messages.cancel}</Button>
      <Button variant="outline" onclick={() => transfers.choose("skip", all)}>{messages.skip}</Button>
      <Button disabled={conflict?.typeConflict} onclick={() => transfers.choose("replace", all)}>{messages.replace}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
<Dialog.Root open={transfers.exclusions !== null} onOpenChange={(open) => { if (!open) transfers.reviewExclusions(false); }}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto">
    <Dialog.Header class="pr-6"><Dialog.Title>{messages.excludedTitle}</Dialog.Title><Dialog.Description>{messages.excludedReview}</Dialog.Description></Dialog.Header>
    <pre class="max-h-60 overflow-auto whitespace-pre-wrap break-all">{transfers.exclusions?.join("\n")}</pre>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => transfers.reviewExclusions(false)}>{messages.cancel}</Button>
      <Button onclick={() => transfers.reviewExclusions(true)}>{messages.continue}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
<Dialog.Root open={reselect !== null} onOpenChange={(open) => { if (!open) reselect = null; }}>
  <Dialog.Content data-testid="transfer-reselect" ondragover={(event) => event.preventDefault()} ondrop={reselectDrop}>
    <Dialog.Header class="pr-6"><Dialog.Title>{messages.reselect}</Dialog.Title><Dialog.Description>{messages.retention}</Dialog.Description></Dialog.Header>
    <p>{messages.reselectDrop}</p>
    <Dialog.Footer>
      <Button onclick={selectFolder}>{messages.uploadFolder}</Button>
      <Button variant="outline" onclick={() => picker?.click()}>{i18n.t.dash.files.upload}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
<Input bind:ref={picker} class="hidden" type="file" multiple onchange={selectFiles} />
