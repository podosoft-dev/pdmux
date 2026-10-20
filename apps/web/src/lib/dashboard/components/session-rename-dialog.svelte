<script lang="ts">
  import { untrack } from "svelte";
  import type { TerminalSlot } from "@pdmux/core";
  import { SESSION_NAME_PATTERN } from "@pdmux/protocol/terminal";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { errorCode, terminalApi } from "../api.js";

  let { open = $bindable(false), slot, onRenamed }: {
    open?: boolean;
    slot: TerminalSlot | null;
    onRenamed: () => Promise<void>;
  } = $props();
  const i18n = getI18n();
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  const valid = $derived(SESSION_NAME_PATTERN.test(name));
  $effect(() => {
    if (!open) return;
    name = untrack(() => slot?.session ?? "");
    error = "";
  });
  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!valid || busy || (!slot?.sessionId && !slot?.tmuxId)) return;
    const target = slot;
    busy = true;
    error = "";
    try {
      await terminalApi.rename(target.hostId, target.sessionId, name, target.tmuxId);
      await onRenamed();
      open = false;
    } catch (cause: unknown) {
      const code = errorCode(cause);
      if (code === "SESSION_EXISTS") error = i18n.t.sessionRename.duplicate;
      else if (code === "SESSION_NOT_FOUND") error = i18n.t.sessionRename.missing;
      else if (code === "SESSION_ENGINE_UPDATE_REQUIRED") error = i18n.t.sessionRename.engineUpdate;
      else if (code === "SESSION_RENAME_UNSUPPORTED" || code === "NATIVE_SESSIONS_UNSUPPORTED") error = i18n.t.sessionRename.update;
      else error = i18n.t.sessionRename.failed;
    } finally { busy = false; }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content showCloseButton={!busy} class="max-h-[90dvh] overflow-y-auto sm:max-w-md" data-testid="session-rename-dialog" onEscapeKeydown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
    <Dialog.Header>
      <Dialog.Title>{i18n.t.sessionRename.title}</Dialog.Title>
      <Dialog.Description>{i18n.t.sessionRename.description}</Dialog.Description>
    </Dialog.Header>
    <form onsubmit={save} class="min-w-0 space-y-4" aria-busy={busy}>
      <div class="space-y-2">
        <Label for="terminal-session-name">{i18n.t.sessionRename.name}</Label>
        <Input id="terminal-session-name" bind:value={name} maxlength={32} disabled={busy} autocomplete="off" autocapitalize="none" spellcheck={false} aria-describedby="terminal-session-name-hint" />
        <p id="terminal-session-name-hint" class="text-muted-foreground text-sm">{i18n.t.sessionRename.hint}</p>
      </div>
      {#if error}<p role="alert" class="text-destructive text-sm">{error}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" disabled={busy} onclick={() => open = false}>{i18n.t.dash.form.cancel}</Button>
        <Button type="submit" disabled={!valid || busy} data-testid="session-rename-save">{busy ? i18n.t.sessionRename.saving : i18n.t.dash.form.save}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
