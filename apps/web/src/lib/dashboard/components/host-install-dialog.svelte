<script lang="ts">
  /**
   * Hand over the one-line installer for a host, and then watch that host arrive.
   *
   * WHY IT OPENS THE MOMENT A HOST IS CREATED: a row in a table is not a machine.
   * The step that makes it one is running a command on the box, and the previous
   * flow closed the form and left the operator on a list with no hint that anything
   * further was required. The finished command is on screen before they have looked
   * away.
   *
   * WHERE THE CODE COMES FROM: `POST /hosts` returns one WITH the host, and that is
   * what `seed` carries — registering a host is one request, not two. The dialog
   * still mints for itself when it is opened from the row menu (no fresh code) or
   * when creation could not mint one (`enrollment: null`, host intact).
   *
   * THE CODE IS SHOWN ONCE, SO THE DIALOG KEEPS IT. Minting REPLACES whatever code
   * the host had, which makes "regenerate" a one-click answer to a mistyped or
   * expired code — and also means an automatic re-mint on every reopen would kill a
   * code the operator had already pasted into an ssh session. So it takes exactly
   * one code per host and holds the plaintext for the life of the page; a second
   * code is only ever an explicit Regenerate.
   *
   * ⚠ NO POLLER LIVES HERE. "Waiting for the agent…" flips to "online" from the
   * shell's own fleet feed — the same poll that draws the cards beside this dialog.
   * A second poll would double the request rate to say something the first one
   * already knows. The one interval this component owns is a 1s clock for the
   * countdown, which talks to nobody.
   */
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import { untrack } from "svelte";
  import { writeClipboard } from "@pdmux/ui";
  import { fmt, getI18n } from "$lib/i18n";
  import { enrollmentsApi } from "$lib/dashboard/api";
  import { causeMessage } from "$lib/dashboard/wording";
  import type { CreatedHostEnrollment, HostView } from "$lib/dashboard/types";

  let {
    open = $bindable(false),
    /** The LIVE row from the shell's feed — that is what makes the status line move. */
    host,
    /** Label to show before the feed has the row (a host created a moment ago). */
    fallbackLabel = "",
    /**
     * The code `POST /hosts` already handed over for `host`, when this dialog was
     * opened by a registration. `null` everywhere else, and then the dialog mints.
     */
    seed = null,
  }: {
    open?: boolean;
    host: HostView | null;
    fallbackLabel?: string;
    seed?: CreatedHostEnrollment | null;
  } = $props();

  const i18n = getI18n();

  /** A mint answers with more than this, but nothing else is ever displayed. */
  let minted = $state<CreatedHostEnrollment | null>(null);
  let mintError = $state<string | null>(null);
  let minting = $state(false);
  /** Host the held code belongs to; guards against showing host A's code for host B. */
  let mintedFor = $state<string | null>(null);
  let copied = $state<"command" | "code" | null>(null);
  let advanced = $state(false);
  /** Ticks only while the dialog is open. No network, so it is not a second poll. */
  let now = $state(Date.now());

  const hostId = $derived(host?.id ?? null);
  const label = $derived(host?.label ?? fallbackLabel);

  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const code = $derived(minted && mintedFor === hostId ? minted.code : null);

  /**
   * Which host operating system the snippets are written for.
   *
   * ⚠ IT IS NOT THE BROWSER'S OS, AND MUST NOT DEFAULT TO IT. The command runs on the
   * HOST, and the machine someone administers a fleet from is routinely not the machine
   * they are enrolling. Linux stays the default because that is what most hosts are;
   * macOS is one click away rather than a thing the operator has to know is supported.
   *
   * ⚠ THE ARCHITECTURE IS NOT A CHOICE. `install.sh` reads `uname -m` and picks the
   * artifact itself, so Intel and Apple Silicon (and amd64/arm64 on Linux) need no
   * selector — only saying so, which the note under the command does.
   */
  type HostOs = "linux" | "macos";
  let hostOs = $state<HostOs>("linux");

  /**
   * Exactly what the public installer documents, with the code already in it.
   *
   * The install line itself is identical on both: `install.sh` detects the OS, the
   * architecture and the service manager. What differs is what it ENDS UP doing, and
   * the one command below that pdmux writes rather than ships.
   */
  const command = $derived(code ? `curl -fsSL ${origin}/install.sh | sh -s -- --code ${code}` : "");
  const userCommand = $derived(command ? `${command} --user` : "");
  const serverCommand = $derived(code ? `${command} --server ${origin}` : "");
  /**
   * The digest tool, per host OS.
   *
   * ⚠ `sha256sum` IS COREUTILS AND MACOS DOES NOT SHIP IT. This snippet used to hardcode
   * it, so the one instruction whose whole point is "do not pipe something you have not
   * read" was the instruction that failed on a Mac — with `command not found`, after the
   * operator had already been told this was the careful path. `install.sh` itself has
   * always handled all three hashers (sha256sum, shasum, openssl); only this snippet,
   * which pdmux writes, did not.
   */
  const hasher = $derived(hostOs === "macos" ? "shasum -a 256" : "sha256sum");
  /**
   * Fetch once, read it, pin the digest, run only if the file still matches.
   *
   * The point of the check here is not that we publish a digest — it is that the bytes
   * that get executed are the bytes the operator read, rather than a second fetch that a
   * proxy could answer differently. `shasum -c` and `sha256sum -c` read the same file
   * format, so the shape holds for both.
   */
  const verifyCommand = $derived(
    code
      ? [
          `curl -fsSL ${origin}/install.sh -o pdmux-install.sh`,
          `${hasher} pdmux-install.sh | tee pdmux-install.sha256`,
          `${hasher} -c pdmux-install.sha256 && sh pdmux-install.sh --code ${code}`,
        ].join("\n")
      : "",
  );
  const serviceNote = $derived(hostOs === "macos" ? i18n.t.dash.enroll.serviceMacos : i18n.t.dash.enroll.serviceLinux);
  const userHint = $derived(hostOs === "macos" ? i18n.t.dash.enroll.userHintMacos : i18n.t.dash.enroll.userHintLinux);
  /** The air-gapped path: a binary carried over by hand + a long-lived token. */

  const secondsLeft = $derived(
    minted && mintedFor === hostId
      ? Math.max(0, Math.floor((new Date(minted.expiresAt).getTime() - now) / 1000))
      : 0,
  );
  const expired = $derived(Boolean(code) && secondsLeft === 0);
  /** Redeemed: the agent is on the wire, so the code is spent and stops being shown. */
  const arrived = $derived(Boolean(host?.online && host?.agentVersion));

  const countdown = $derived.by(() => {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  });

  async function mint(id: string): Promise<void> {
    minting = true;
    mintError = null;
    try {
      minted = await enrollmentsApi.create(id);
      mintedFor = id;
      now = Date.now();
    } catch (cause: unknown) {
      // The host EXISTS — it was created before this call. A toast that vanishes
      // would leave the operator on a list with a machine they cannot install onto
      // and no idea why, so the failure stays on screen with a way to retry.
      minted = null;
      mintedFor = null;
      mintError = causeMessage(cause, i18n.t);
    } finally {
      minting = false;
    }
  }

  /** Take a code on the first open for a host; never silently replace a live one. */
  $effect(() => {
    const id = open ? hostId : null;
    const handed = seed;
    untrack(() => {
      if (id === null) return;
      if (mintedFor === id || minting) return;
      copied = null;
      if (handed) {
        // Registration already returned a live code for this host. Minting again
        // would cost a request AND retire the code that is about to be displayed —
        // the one the operator may already be pasting.
        minted = handed;
        mintedFor = id;
        mintError = null;
        now = Date.now();
        return;
      }
      void mint(id);
    });
  });

  $effect(() => {
    if (!open) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function copy(text: string, which: "command" | "code"): Promise<void> {
    // `writeClipboard`, not `navigator.clipboard`: a self-hosted pdmux on plain
    // http has no `navigator.clipboard` at all, and that is exactly the deployment
    // where a one-shot code has to reach another terminal.
    await writeClipboard(text);
    copied = which;
  }

  async function regenerate(): Promise<void> {
    if (!hostId) return;
    mintedFor = null;
    copied = null;
    await mint(hostId);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" data-testid="enroll-dialog">
    <Dialog.Header>
      <Dialog.Title>{fmt(i18n.t.dash.enroll.title, { label })}</Dialog.Title>
      <Dialog.Description>{i18n.t.dash.enroll.subtitle}</Dialog.Description>
    </Dialog.Header>

    {#if mintError}
      <div class="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3">
        <p class="text-sm" data-testid="enroll-error">{mintError}</p>
        <p class="text-muted-foreground text-xs">{i18n.t.dash.enroll.errorHint}</p>
        <div>
          <Button size="sm" variant="outline" disabled={minting} onclick={regenerate} data-testid="enroll-retry">
            {i18n.t.dash.enroll.retry}
          </Button>
        </div>
      </div>
    {:else if arrived}
      <p class="text-sm" data-testid="enroll-status">
        {fmt(i18n.t.dash.enroll.arrived, { version: host?.agentVersion ?? "" })}
      </p>
    {:else}
      <p class="text-sm">{i18n.t.dash.enroll.runHint}</p>

      <!-- The host's OS, not the browser's. It changes the digest tool below and what
           the installer ends up registering; the install line itself is the same. -->
      <Tabs.Root bind:value={() => hostOs, (v) => (hostOs = v as HostOs)}>
        <Tabs.List data-testid="enroll-os">
          <Tabs.Trigger value="linux" data-testid="enroll-os-linux">{i18n.t.dash.enroll.osLinux}</Tabs.Trigger>
          <Tabs.Trigger value="macos" data-testid="enroll-os-macos">{i18n.t.dash.enroll.osMacos}</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      <pre
        class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
        data-testid="enroll-command">{minting ? i18n.t.dash.enroll.minting : command}</pre>
      <p class="text-muted-foreground text-xs" data-testid="enroll-service-note">{serviceNote}</p>

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={!command} onclick={() => copy(command, "command")} data-testid="enroll-command-copy">
          {copied === "command" ? i18n.t.dash.tokens.copied : i18n.t.dash.enroll.copyCommand}
        </Button>
        <Button variant="outline" size="sm" disabled={minting} onclick={regenerate} data-testid="enroll-regenerate">
          {i18n.t.dash.enroll.regenerate}
        </Button>
        <span class="text-muted-foreground text-xs" data-testid="enroll-countdown">
          {#if expired}
            {i18n.t.dash.enroll.expired}
          {:else}
            {fmt(i18n.t.dash.enroll.expiresIn, { countdown })}
          {/if}
        </span>
      </div>

      <!-- The code on its own: an operator already sitting in an ssh session types
           this rather than pasting a command that would re-download the script. -->
      <div class="flex flex-col gap-1.5">
        <span class="text-muted-foreground text-xs">{i18n.t.dash.enroll.codeOnly}</span>
        <div class="flex items-center gap-2">
          <code class="bg-muted flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs" data-testid="enroll-code"
            >{code ?? "—"}</code
          >
          <Button variant="outline" size="sm" disabled={!code} onclick={() => copy(code ?? "", "code")} data-testid="enroll-code-copy">
            {copied === "code" ? i18n.t.dash.tokens.copied : i18n.t.dash.tokens.copy}
          </Button>
        </div>
      </div>

      <p class="text-muted-foreground text-sm" data-testid="enroll-status">
        {host?.online ? i18n.t.dash.enroll.onlineNoVersion : i18n.t.dash.enroll.waiting}
      </p>
    {/if}

    <Collapsible.Root bind:open={advanced}>
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm" class="gap-1 px-0" data-testid="enroll-advanced">
            <ChevronDownIcon class="size-4 {advanced ? 'rotate-180' : ''}" />
            {i18n.t.dash.enroll.advanced}
          </Button>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content class="flex flex-col gap-3 pt-2">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium">{i18n.t.dash.enroll.userTitle}</span>
          <p class="text-muted-foreground text-xs" data-testid="enroll-user-hint">{userHint}</p>
          <pre
            class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
            data-testid="enroll-advanced-user">{userCommand}</pre>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium">{i18n.t.dash.enroll.serverTitle}</span>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.enroll.serverHint}</p>
          <pre
            class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
            data-testid="enroll-advanced-server">{serverCommand}</pre>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium">{i18n.t.dash.enroll.verifyTitle}</span>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.enroll.verifyHint}</p>
          <pre
            class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
            data-testid="enroll-advanced-verify">{verifyCommand}</pre>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium">{i18n.t.dash.enroll.manualTitle}</span>
          <p class="text-muted-foreground text-xs">{i18n.t.dash.enroll.manualHint}</p>
          <!--
            ⚠ NO COMMAND HERE ANY MORE. This block used to print
            `pdmux-agent install --server … --token pdmux_…` — with a literal
            ellipsis where the secret goes, so it could be copied but never run.
            The real, runnable line is handed over once by the token dialog on
            the host page, which is also where the hint above already sends you.
            Two renderings of one command, and the useless one came first.
          -->
          {#if hostId}
            <a class="text-xs underline" href={`/hosts/${hostId}`} data-testid="enroll-tokens-link">
              {i18n.t.dash.enroll.manualLink}
            </a>
          {/if}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>

    <Dialog.Footer>
      <Button onclick={() => (open = false)} data-testid="enroll-close">{i18n.t.dash.tokens.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
