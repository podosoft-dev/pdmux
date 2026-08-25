<script lang="ts">
  /**
   * Register a host — or edit one — and hand over the install command the instant one
   * is created.
   *
   * ONE COMPONENT, SO THERE IS ONE ADD PATH. Two screens need "add a host" (the
   * dashboard's own card column and the host list), and the valuable half of that is
   * not the form: it is what happens when `create` answers. A row is not a machine,
   * `POST /hosts` returns the enrollment code WITH the host, and the operator has to
   * see the one-line installer before they look away. Written twice, one of the two
   * would have been the poorer flow — so both mount this and neither owns a form of
   * its own.
   *
   * ⚠ IT READS THE SHELL'S FEED rather than taking a host list. Two reasons: the
   * install dialog's status line ("waiting for the agent…" → "the agent is connected")
   * moves with the shell's existing poll, and refreshing that one feed after a
   * mutation updates the cards and the table at once. Both call sites live inside
   * `(shell)`, which is what makes `useShellState()` available here.
   */
  import { untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { toast } from "svelte-sonner";
  import { getI18n } from "#lib/i18n/index.js";
  import { hostsApi } from "#lib/dashboard/api.js";
  import HostInstallDialog from "#lib/dashboard/components/host-install-dialog.svelte";
  import { useShellState } from "#lib/dashboard/shell-state.svelte.ts";
  import { causeMessage, codeMessage } from "#lib/dashboard/wording.js";
  import type { CreatedHostEnrollment, HostView } from "#lib/dashboard/types.js";

  let {
    open = $bindable(false),
    /** The host being edited. `null` — the default — registers a new one. */
    host = null,
  }: {
    open?: boolean;
    host?: HostView | null;
  } = $props();

  const i18n = getI18n();
  const shell = useShellState();

  const editing = $derived(host !== null);
  let form = $state({ label: "", address: "", description: "", tags: "" });
  let saving = $state(false);

  /**
   * Seed the fields when the dialog OPENS, and at no other time.
   *
   * `host` is read untracked on purpose: the fleet poll replaces every row object
   * every few seconds, and tracking it would re-seed the form — wiping whatever the
   * operator had typed — on the next tick of a poll that changed nothing they care
   * about.
   */
  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = host
        ? {
            label: host.label,
            address: host.address ?? "",
            description: host.description ?? "",
            tags: (host.tags ?? []).join(", "),
          }
        : { label: "", address: "", description: "", tags: "" };
    });
  });

  /** Pull the fleet again, so the cards AND any table on screen show the change. */
  async function refresh(): Promise<void> {
    await shell.feed.refresh();
    // The feed keeps the last good list on screen and records the code instead of
    // throwing, so a failure has to be read back rather than caught.
    if (shell.feed.error) toast.error(codeMessage(shell.feed.error, i18n.t));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!form.label.trim()) {
      toast.error(i18n.t.dash.error.hostLabel);
      return;
    }
    saving = true;
    const input = {
      label: form.label.trim(),
      address: form.address.trim() || null,
      description: form.description.trim() || null,
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    try {
      if (host) {
        await hostsApi.update(host.id, input);
        open = false;
        await refresh();
      } else {
        // A row is not a machine. The step that makes it one is a command on the box,
        // so the install dialog opens straight from `create` rather than leaving the
        // operator with a new card and no hint that anything is missing.
        // ONE REQUEST: the code comes back with the host, so there is nothing to mint
        // here — the dialog is handed what this call already returned.
        const created = await hostsApi.create(input);
        open = false;
        await refresh();
        installHostId = created.id;
        installLabel = input.label;
        installSeed = created.enrollment;
        installOpen = true;
      }
    } catch (cause: unknown) {
      toast.error(causeMessage(cause, i18n.t));
    } finally {
      saving = false;
    }
  }

  // --- install (enrollment code) -------------------------------------------
  let installOpen = $state(false);
  let installHostId = $state<string | null>(null);
  let installLabel = $state("");
  /** The code creation handed over — this dialog is only ever opened by one. */
  let installSeed = $state<CreatedHostEnrollment | null>(null);
  /** The LIVE row, so the install dialog's status line moves with the shell's poll. */
  const installHost = $derived(shell.feed.hosts.find((row) => row.id === installHostId) ?? null);
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="host-form">
    <Dialog.Header>
      <Dialog.Title>{editing ? i18n.t.dash.hosts.editTitle : i18n.t.dash.hosts.addTitle}</Dialog.Title>
    </Dialog.Header>
    <form onsubmit={submit} class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <Label for="host-label">{i18n.t.dash.hosts.label}</Label>
        <Input id="host-label" bind:value={form.label} required data-testid="host-label" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="host-address">{i18n.t.dash.hosts.address}</Label>
        <Input id="host-address" bind:value={form.address} data-testid="host-address" />
        <p class="text-muted-foreground text-xs">{i18n.t.dash.hosts.addressHint}</p>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="host-description">{i18n.t.dash.hosts.description}</Label>
        <Input id="host-description" bind:value={form.description} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="host-tags">{i18n.t.dash.hosts.tags}</Label>
        <Input id="host-tags" bind:value={form.tags} />
        <p class="text-muted-foreground text-xs">{i18n.t.dash.hosts.tagsHint}</p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>{i18n.t.dash.form.cancel}</Button>
        <Button type="submit" disabled={saving} data-testid="host-save">
          {editing ? i18n.t.dash.form.save : i18n.t.dash.form.create}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<HostInstallDialog bind:open={installOpen} host={installHost} fallbackLabel={installLabel} seed={installSeed} />
