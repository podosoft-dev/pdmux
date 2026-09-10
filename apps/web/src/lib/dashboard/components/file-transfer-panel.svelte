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

  let { transfers, hostLabel }: { transfers: FileTransferController; hostLabel: (id: string) => string } = $props();
  const i18n = getI18n();
  const messages = $derived(i18n.t.dash.files.transfers);
  let all = $state(false);
  let reselect = $state<FileTransferView | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  const conflict = $derived(transfers.conflict);
  const columns = $derived([{ key: "created", label: messages.title, sortable: true, class: "w-full" }]);

  function reason(code: string): string {
    if (code === "FILES_TRANSFER_SOURCE_CHANGED") return messages.sourceChanged;
    if (code === "FILES_TRANSFER_LIMIT") return messages.limit;
    if (code === "FILES_TRANSFER_DISK_FULL") return messages.diskFull;
    if (code === "FILES_TRANSFER_PICKER_UNSUPPORTED") return messages.pickerUnsupported;
    if (code === "HOST_FILES_TRANSFER_UNSUPPORTED") return messages.upgrade;
    if (code === "FILES_TRANSFER_RESELECT") return messages.reselect;
    if (code === "FILES_TRANSFER_EXCLUDED") return messages.excluded;
    return messages.genericError;
  }
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

{#if transfers.jobs.length || transfers.preparing || transfers.error}
  <section class="max-h-[45%] min-h-0 shrink-0 overflow-auto border-t text-xs" data-testid="file-transfer-panel" aria-label={messages.title}>
    <Button variant="ghost" size="sm" class="h-7 w-full justify-between px-2 text-xs" aria-expanded={transfers.expanded} onclick={() => (transfers.expanded = !transfers.expanded)}>
      <span>{messages.title}</span><span>{transfers.jobs.length}</span>
    </Button>
    {#if transfers.expanded}
      {#if transfers.error}<p class="text-destructive break-words px-2 py-1" role="alert">{reason(transfers.error)}</p>{/if}
      {#if transfers.preparing}
        {@const preparation = transfers.preparing}
        <div class="space-y-1 px-2 py-1" data-testid="transfer-preparation">
          <p>{preparation.phase === "scanning" ? messages.scanning : messages.hashing} · {preparation.count}</p>
          <p class="truncate">{preparation.path}</p>
          <Progress value={preparation.phase === "scanning" || !preparation.totalBytes ? null : preparation.bytes / preparation.totalBytes * 100} aria-label={messages.hashing} />
          <Button size="sm" variant="outline" onclick={() => transfers.cancelPreparation()}>{messages.cancelPreparation}</Button>
        </div>
      {/if}
      {#if transfers.jobs.length}
        <DataTable rows={transfers.jobs} {columns} getKey={(job) => job.id} perPage={3} empty={messages.empty} ariaLabel={messages.title}>
          {#snippet row(job)}
            <Table.Cell class="max-w-0 whitespace-normal px-2 py-2">
              <div class="space-y-1" data-testid="transfer-job" data-transfer-id={job.id} data-transfer-state={job.state}>
                <p class="truncate" title={job.basePath}>{hostLabel(job.hostId)} · ~/{job.basePath}</p>
                <p class="text-muted-foreground">{messages.states[job.state]} · {job.direction === "upload" ? messages.uploading : messages.downloading}</p>
                <p class="truncate" title={job.currentPath}>{job.currentPath}</p>
                <Progress value={percent(job)} aria-label={messages.states[job.state]} />
                <p class="flex flex-wrap justify-between gap-1 tabular-nums">
                  <span>{humanSize(job.bytes)} / {humanSize(job.totalBytes)}</span>
                  <span>{fmt(messages.count, { done: String(job.completedEntries), total: String(job.totalEntries) })}</span>
                </p>
                {#if job.errorCode}<p class="text-destructive break-words">{reason(job.errorCode)}</p>{/if}
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
                    <Button size="sm" class="h-7 text-xs" onclick={() => void transfers.save(job)}>{messages.save}</Button>
                  {/if}
                  {#if !["completed", "cancelled", "expired"].includes(job.state)}
                    <Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => void transfers.cancel(job)}>{messages.cancel}</Button>
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
      <p class="text-muted-foreground px-2 py-1">{messages.retention}</p>
    {/if}
  </section>
{/if}

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
  <Dialog.Content ondragover={(event) => event.preventDefault()} ondrop={reselectDrop}>
    <Dialog.Header class="pr-6"><Dialog.Title>{messages.reselect}</Dialog.Title><Dialog.Description>{messages.retention}</Dialog.Description></Dialog.Header>
    <p>{messages.reselectDrop}</p>
    <Dialog.Footer>
      <Button onclick={selectFolder}>{messages.uploadFolder}</Button>
      <Button variant="outline" onclick={() => picker?.click()}>{i18n.t.dash.files.upload}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
<Input bind:ref={picker} class="hidden" type="file" multiple onchange={selectFiles} />
