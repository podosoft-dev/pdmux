<script lang="ts">
  import { untrack } from "svelte";
  import { normalizeTerminalPresentation, terminalTagForeground, TERMINAL_LABEL_MAX, TERMINAL_TAG_NAME_MAX, TERMINAL_TAGS_MAX, type TerminalPresentation, type TerminalTag } from "@pdmux/core";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TrashIcon from "@lucide/svelte/icons/trash-2";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { getI18n } from "#lib/i18n/index.js";

  let { open = $bindable(false), value, onSave }: {
    open?: boolean;
    value: TerminalPresentation | null;
    onSave: (value: TerminalPresentation) => void;
  } = $props();
  const i18n = getI18n();
  let label = $state("");
  let tags = $state<TerminalTag[]>([]);
  const valid = $derived(tags.every(tag => tag.name.trim() && /^#[0-9a-f]{6}$/i.test(tag.color)
    && (tag.textColor === undefined || /^#[0-9a-f]{6}$/i.test(tag.textColor))));
  $effect(() => {
    if (!open) return;
    const initial = untrack(() => normalizeTerminalPresentation(value));
    label = initial.label ?? "";
    tags = initial.tags?.map(tag => ({ ...tag })) ?? [];
  });
  function save(event: SubmitEvent): void {
    event.preventDefault();
    if (!valid) return;
    onSave(normalizeTerminalPresentation({ label, tags }));
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="terminal-presentation-dialog">
    <Dialog.Header>
      <Dialog.Title>{i18n.t.terminalPresentation.title}</Dialog.Title>
      <Dialog.Description>{i18n.t.terminalPresentation.description}</Dialog.Description>
    </Dialog.Header>
    <form onsubmit={save} class="min-w-0 space-y-5">
      <div class="space-y-2">
        <Label for="terminal-display-name">{i18n.t.terminalPresentation.label}</Label>
        <Input id="terminal-display-name" bind:value={label} maxlength={TERMINAL_LABEL_MAX} placeholder={i18n.t.terminalPresentation.placeholder} />
      </div>
      <div class="min-w-0 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <Label>{i18n.t.terminalPresentation.tags}</Label>
          <Button type="button" variant="outline" size="sm" disabled={tags.length >= TERMINAL_TAGS_MAX} onclick={() => tags = [...tags, { name: "", color: "#2563eb" }]} data-testid="terminal-tag-add">
            <PlusIcon class="size-4" />{i18n.t.terminalPresentation.addTag}
          </Button>
        </div>
        {#each tags as tag, index}
          <div class="min-w-0 space-y-2 rounded-md border p-3" data-testid="terminal-tag-row">
            <div class="flex min-w-0 items-center gap-2">
              <Input class="min-w-0 flex-1" bind:value={tag.name} maxlength={TERMINAL_TAG_NAME_MAX} aria-label={i18n.t.terminalPresentation.tagName} />
              <Button type="button" variant="ghost" size="icon" aria-label={i18n.t.terminalPresentation.removeTag} onclick={() => tags = tags.filter((_, at) => at !== index)}><TrashIcon class="size-4" /></Button>
            </div>
            <div class="flex flex-wrap items-end gap-3">
              <div class="space-y-1">
                <Label for={`terminal-tag-background-${index}`} class="text-xs">{i18n.t.terminalPresentation.tagColor}</Label>
                <Input id={`terminal-tag-background-${index}`} type="color" class="size-10 cursor-pointer p-1" bind:value={tag.color} />
              </div>
              <div class="space-y-1">
                <Label for={`terminal-tag-text-${index}`} class="text-xs">{i18n.t.terminalPresentation.tagTextColor}</Label>
                <Input id={`terminal-tag-text-${index}`} type="color" class="size-10 cursor-pointer p-1" value={terminalTagForeground(tag.color, tag.textColor)} oninput={(event) => tag.textColor = event.currentTarget.value} />
              </div>
              <Button type="button" variant="outline" size="sm" class="mb-1" disabled={tag.textColor === undefined} onclick={() => delete tag.textColor} data-testid="terminal-tag-text-auto">{i18n.t.terminalPresentation.automaticTextColor}</Button>
            </div>
          </div>
        {/each}
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => open = false}>{i18n.t.dash.form.cancel}</Button>
        <Button type="submit" disabled={!valid} data-testid="terminal-presentation-save">{i18n.t.dash.form.save}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
