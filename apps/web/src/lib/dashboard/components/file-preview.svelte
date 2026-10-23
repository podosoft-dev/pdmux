<script lang="ts">
  import { onMount } from "svelte";
  import { mimeOf } from "@pdmux/core";
  import { BlobView } from "@pdmux/ui";
  import type { Translate } from "@pdmux/ui";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import type { FilePreview } from "../files-dock.svelte";
  import type { FsFileView } from "../types";
  import { filesApi } from "../api";
  import MarkdownPreview from "./markdown-preview.svelte";

  let { preview, file, loading, mode, hostId, t, onOpenFile }: {
    preview: FilePreview; file: FsFileView | null; loading: boolean; mode: string; hostId: string;
    t?: Translate; onOpenFile: (path: string) => void;
  } = $props();
  const i18n = getI18n();
  let mounted = $state(false);
  let failed = $state(false);
  onMount(() => { mounted = true; });
  $effect(() => { preview.path; failed = false; });
  const mime = $derived(mimeOf(preview.path));
  const supported = $derived.by(() => {
    if (!mounted) return true;
    if (preview.kind === "pdf") return navigator.pdfViewerEnabled;
    if (preview.kind === "audio" || preview.kind === "video") return document.createElement(preview.kind).canPlayType(mime) !== "";
    return preview.kind !== null;
  });
</script>

{#if failed || !supported || preview.kind === null}
  <div class="space-y-3 p-3 text-sm" data-testid="file-preview-fallback">
    <p class="text-muted-foreground">{i18n.t.dash.files.preview.unavailable}</p>
    <Button size="sm" variant="outline" href={filesApi.url(hostId, preview.path)}>{i18n.t.dash.files.downloadLabel}</Button>
  </div>
{:else if preview.kind === "markdown" && mode === "preview" && file && !file.error && !file.binary}
  <MarkdownPreview {file} {hostId} {onOpenFile} />
{:else if preview.kind === "text" || preview.kind === "markdown"}
  <BlobView blob={file} {loading} {t} />
{:else if preview.kind === "image"}
  <img class="mx-auto block max-h-full max-w-full object-contain" src={preview.url} alt={preview.path.split("/").pop()} onerror={() => failed = true} data-testid="file-preview-image" />
{:else if preview.kind === "pdf"}
  <object data={preview.url} type="application/pdf" class="h-full min-h-0 w-full" aria-label={preview.path} data-testid="file-preview-pdf">
    <a href={filesApi.url(hostId, preview.path)}>{i18n.t.dash.files.downloadLabel}</a>
  </object>
{:else if preview.kind === "audio"}
  <div class="p-3"><audio class="w-full" src={preview.url} controls preload="metadata" onerror={() => failed = true} data-testid="file-preview-audio"></audio></div>
{:else if preview.kind === "video"}
  <video class="h-full max-h-full w-full object-contain" src={preview.url} controls playsinline preload="metadata" onerror={() => failed = true} data-testid="file-preview-video"><track kind="captions" /></video>
{/if}
