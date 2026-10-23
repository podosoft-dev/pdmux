<script lang="ts">
  import { onMount } from "svelte";
  import { getI18n } from "#lib/i18n/index.js";
  import type { FsFileView } from "../types";
  import { filesApi } from "../api";

  let { file, hostId, onOpenFile }: { file: FsFileView; hostId: string; onOpenFile: (path: string) => void } = $props();
  const i18n = getI18n();
  let renderer = $state<typeof import("../file-preview") | null>(null);
  let failed = $state(false);
  let article = $state<HTMLElement | null>(null);
  $effect(() => {
    const node = article;
    if (!node) return;
    node.addEventListener("click", open);
    return () => node.removeEventListener("click", open);
  });
  onMount(() => {
    let alive = true;
    void import("../file-preview").then((value) => { if (alive) renderer = value; }).catch(() => { if (alive) failed = true; });
    return () => { alive = false; };
  });
  const html = $derived(renderer?.renderMarkdown(file.lines.join("\n"), file.path, (path, inline) => filesApi.url(hostId, path, inline)) ?? "");
  function open(event: MouseEvent): void {
    const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-file-path]") : null;
    const path = element?.dataset.filePath;
    if (path && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpenFile(path); }
  }
</script>

{#if failed}<p class="p-3 text-muted-foreground">{i18n.t.dash.files.preview.unavailable}</p>
{:else if !renderer}<p class="p-3 text-muted-foreground">{i18n.t.dash.files.preview.loading}</p>
{:else}
  {#if file.truncated}<p class="border-b p-2 text-xs text-muted-foreground">{i18n.t.dash.files.preview.truncated}</p>{/if}
  <article bind:this={article} class="pdmux-markdown" data-testid="markdown-preview">{@html html}</article>
{/if}

<style>
  .pdmux-markdown { padding: 12px; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
  .pdmux-markdown :global(h1), .pdmux-markdown :global(h2), .pdmux-markdown :global(h3) { font-weight: 600; margin: 1em 0 .5em; }
  .pdmux-markdown :global(h1) { font-size: 1.5em; }
  .pdmux-markdown :global(h2) { font-size: 1.25em; }
  .pdmux-markdown :global(p), .pdmux-markdown :global(ul), .pdmux-markdown :global(ol), .pdmux-markdown :global(pre), .pdmux-markdown :global(table) { margin: .6em 0; }
  .pdmux-markdown :global(ul) { list-style: disc; padding-left: 1.5em; }
  .pdmux-markdown :global(ol) { list-style: decimal; padding-left: 1.5em; }
  .pdmux-markdown :global(a) { color: var(--primary); text-decoration: underline; }
  .pdmux-markdown :global(pre) { overflow: auto; padding: 10px; background: var(--muted); border-radius: 4px; }
  .pdmux-markdown :global(code) { font-family: ui-monospace, monospace; font-size: .9em; }
  .pdmux-markdown :global(blockquote) { border-left: 3px solid var(--border); padding-left: 12px; color: var(--muted-foreground); }
  .pdmux-markdown :global(table) { display: block; overflow: auto; border-collapse: collapse; max-width: 100%; }
  .pdmux-markdown :global(th), .pdmux-markdown :global(td) { padding: 4px 8px; border: 1px solid var(--border); }
  .pdmux-markdown :global(img) { max-width: 100%; height: auto; }
  .pdmux-markdown :global(input) { pointer-events: none; }
</style>
