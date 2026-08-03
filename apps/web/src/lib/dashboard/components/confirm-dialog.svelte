<script lang="ts">
  /**
   * Confirmation before something the user cannot undo with the same click.
   *
   * Two strengths, one component. With a `label` the user has to retype the thing's
   * own name: deleting a host takes its services, its tokens and its collected history
   * with it, and the dashboard is a grid of rows that look alike, so retyping proves
   * they are looking at the row they think they are — which a second button never does.
   * Without a `label` it is a plain two-button confirm, which is right when the action
   * is reversible and the cost of the gate would exceed the cost of the mistake
   * (closing a pane: the session keeps running and reopening reattaches).
   *
   * `details` is for when the thing being destroyed is a SET rather than a row. The
   * typing gate proves you are looking at what you think you are, and for a batch the
   * thing you can be wrong about is which hosts are in it — so the caller passes the
   * list and retypes the count. A warning sentence cannot carry eleven labels.
   */
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import { getI18n } from "$lib/i18n";

  let {
    open = $bindable(false),
    title,
    warning,
    label = "",
    confirmLabel,
    testId = "confirm-dialog",
    details,
    onConfirm,
  }: {
    open?: boolean;
    title: string;
    warning: string;
    /** Exact text the user has to type — the row's own label. Empty = no typing gate. */
    label?: string;
    confirmLabel?: string;
    testId?: string;
    /** What is about to go, when it is more than the title can name. */
    details?: Snippet;
    onConfirm: () => void | Promise<void>;
  } = $props();

  const i18n = getI18n();
  let typed = $state("");
  let busy = $state(false);
  const armed = $derived(label === "" || typed.trim() === label);

  // A reopened dialog must not still hold the previous confirmation.
  $effect(() => {
    if (!open) typed = "";
  });

  async function confirm(): Promise<void> {
    if (!armed || busy) return;
    busy = true;
    try {
      await onConfirm();
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid={testId}>
    <Dialog.Header><Dialog.Title>{title}</Dialog.Title></Dialog.Header>
    <p class="text-muted-foreground text-sm">{warning}</p>
    {#if details}
      <!-- Bounded and scrollable: the caller decides how many rows this is, and a
           dialog that grows past the viewport puts its own confirm button off screen. -->
      <div class="max-h-52 overflow-y-auto text-sm" data-testid={`${testId}-details`}>{@render details()}</div>
    {/if}
    {#if label}
      <Input bind:value={typed} placeholder={label} data-testid={`${testId}-input`} aria-label={label} />
    {/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>{i18n.t.dash.form.cancel}</Button>
      <Button variant="destructive" disabled={!armed || busy} data-testid={`${testId}-confirm`} onclick={confirm}>
        {confirmLabel ?? i18n.t.dash.form.confirm}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
