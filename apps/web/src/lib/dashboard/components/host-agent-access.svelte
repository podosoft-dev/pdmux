<script lang="ts">
  /**
   * Connect a coding CLI on this host to pdmux.
   *
   * THE POINT OF THE SCREEN: a person registers a machine, mints a key here, and
   * pastes two lines into their CLI's config. They never open the pdmux source,
   * never hold an admin password, and never see a host id.
   *
   * ⚠ THE COPYABLE CONFIG MUST NOT CONTAIN THE KEY. It names an environment
   * variable instead. A config block is the single most likely thing on this page
   * to end up committed to a repository, and a secret that travels in it is a
   * secret that leaks by construction. The plaintext appears exactly once, in a
   * dialog, and the server keeps only a hash — so there is no "show it again".
   *
   * ⚠ THE CLIENT TAB DEFAULTS FROM WHAT THE HOST REPORTS, not from a guess. The
   * agent already tells us which coding CLIs run there (`host.usage[].provider`),
   * so a machine running Codex opens on Codex. That is an observation, not a
   * preference, and it is the difference between "here are two options" and "here
   * is your command".
   */
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Table from "$lib/components/ui/table";
  import DataTable, { type DataTableColumn, type SortState } from "$lib/components/data-table.svelte";
  import { writeClipboard } from "@pdmux/ui";
  import { fmt, getI18n } from "$lib/i18n";
  import { mcpKeysApi } from "$lib/dashboard/api";
  import { causeMessage } from "$lib/dashboard/wording";
  import type { HostView, McpKeyView, MintedMcpKey } from "$lib/dashboard/types";

  let {
    host,
    canManage = false,
    /**
     * How many keys this host has, surfaced so the collapsed card can say it
     * without being opened. `null` until the first load answers — the caller
     * renders nothing for null rather than claiming "0 keys" before asking.
     */
    keyCount = $bindable<number | null>(null),
  }: { host: HostView; canManage?: boolean; keyCount?: number | null } = $props();

  const i18n = getI18n();

  /** The env var the config points at. Named once, used in both clients and the handoff. */
  const ENV_VAR = "PDMUX_MCP_KEY";

  let keySort = $state<SortState | null>(null);
  let keyPage = $state(1);
  const keyColumns = $derived<DataTableColumn<McpKeyView>[]>([
    { key: "label", label: i18n.t.dash.mcp.keyLabel, sortable: true },
    { key: "keyPrefix", label: i18n.t.dash.mcp.keyPrefix },
    { key: "scopes", label: i18n.t.dash.mcp.keyScope },
    { key: "status", label: i18n.t.dash.mcp.keyStatus },
    { key: "expiresAt", label: i18n.t.dash.mcp.keyExpiry, sortable: true },
    { key: "actions", label: i18n.t.dash.mcp.keyActions },
  ]);

  let keys = $state<McpKeyView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let minting = $state(false);
  /** Held for the life of the dialog and nowhere else — never written to state that outlives it. */
  let revealed = $state<MintedMcpKey | null>(null);
  let copied = $state<string | null>(null);

  let label = $state("");
  let expiresInDays = $state("90");
  let scope = $state("read-write");

  /**
   * Which CLI the snippets are written for.
   *
   * Seeded from the host's own usage report; falls back to Codex only when the
   * host has told us nothing.
   */
  type ClientId = "codex" | "claude";
  const reported = $derived((host.usage ?? []).map((row) => row.provider));
  let chosen = $state<ClientId | null>(null);
  const client = $derived<ClientId>(chosen ?? (reported.includes("claude") ? "claude" : "codex"));

  /**
   * Which OS the shell snippets are written for.
   *
   * ⚠ UNLIKE THE INSTALL DIALOG, THIS PAGE KNOWS. That dialog runs before a host
   * has ever connected, so it can only offer a choice and default to Linux. Here
   * the agent has already reported `os`, so the tab opens on the truth and the
   * operator only touches it to see the other one.
   */
  type HostOs = "linux" | "macos";
  let chosenOs = $state<HostOs | null>(null);
  const hostOs = $derived<HostOs>(chosenOs ?? (host.os === "darwin" ? "macos" : "linux"));

  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const endpoint = $derived(`${origin}/mcp`);

  /**
   * Where the key goes on that machine.
   *
   * ⚠ THE VALUE IS A PLACEHOLDER, NOT THE KEY. This line is as copyable as the
   * config block above it, so it gets the same treatment: a person pastes it and
   * substitutes the secret themselves.
   *
   * The file differs because the default login shell does: zsh on macOS since
   * Catalina, bash on most Linux distributions. Writing the wrong one is not an
   * error anybody sees — the variable simply never appears, and the CLI reports a
   * 401 that looks like a bad key.
   */
  const shellFile = $derived(hostOs === "macos" ? "~/.zshrc" : "~/.bashrc");
  const envCommand = $derived(
    [`echo 'export ${ENV_VAR}=<paste your key>' >> ${shellFile}`, `source ${shellFile}`].join("\n"),
  );

  const codexConfig = $derived(`codex mcp add pdmux --url ${endpoint} --bearer-token-env-var ${ENV_VAR}`);
  const claudeConfig = $derived(
    JSON.stringify(
      { mcpServers: { pdmux: { type: "http", url: endpoint, headers: { Authorization: `Bearer \${${ENV_VAR}}` } } } },
      null,
      2,
    ),
  );
  const config = $derived(client === "claude" ? claudeConfig : codexConfig);

  /**
   * What a person pastes into their agent to start it off.
   *
   * It carries the host label, the endpoint, the variable name and the order to
   * do things in — and NO credential. A spec asserts the key prefix never appears
   * here, because "safe to paste anywhere" is the entire value of this block.
   */
  const handoff = $derived(
    fmt(i18n.t.dash.mcp.handoffText, { label: host.label, endpoint, envVar: ENV_VAR }),
  );

  /**
   * ⚠ THE ID IS AN ARGUMENT, NOT A READ OF `host`. The first attempt at this fix
   * only changed what the EFFECT read and it did nothing, because the effect
   * calls this function and this function read `host.id` synchronously — which
   * registers `host` as a dependency of the effect just the same. Measured after
   * that "fix": still 9 `/hosts` to 8 `/mcp-keys`. Nothing inside here may touch
   * the reactive object.
   */
  async function load(id: string): Promise<void> {
    loading = true;
    error = null;
    try {
      keys = await mcpKeysApi.list(id);
      keyCount = keys.filter((key) => !key.revokedAt).length;
    } catch (cause) {
      error = causeMessage(cause, i18n.t);
    } finally {
      loading = false;
    }
  }

  /**
   * ⚠ THE EFFECT DEPENDS ON THE ID, NOT ON `host`, AND THAT IS THE WHOLE FIX.
   * The parent's `host` is a `$derived` off the dashboard feed, so every poll
   * (~5s) produces a NEW object with the same id. An effect that read `host.id`
   * directly therefore re-ran on every poll and re-fetched the key list forever
   * — measured in the API log as 12 `/hosts` against 12 `/mcp-keys`, exactly
   * one-to-one. A `$derived` of the id is a string, so it only propagates when
   * the id actually changes.
   */
  const hostId = $derived(host.id);
  $effect(() => {
    if (hostId) void load(hostId);
  });

  async function mint(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    minting = true;
    error = null;
    try {
      revealed = await mcpKeysApi.mint(host.id, {
        label: label.trim() || i18n.t.dash.mcp.defaultLabel,
        expiresInDays: Number(expiresInDays),
        scopes: scope === "read" ? ["read"] : ["read", "write"],
      });
      label = "";
      await load(host.id);
    } catch (cause) {
      error = causeMessage(cause, i18n.t);
    } finally {
      minting = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    try {
      await mcpKeysApi.revoke(host.id, id);
      await load(host.id);
    } catch (cause) {
      error = causeMessage(cause, i18n.t);
    }
  }

  async function copy(text: string, which: string): Promise<void> {
    // `writeClipboard`, not `navigator.clipboard`: a self-hosted pdmux on plain
    // http has no `navigator.clipboard`, and that is exactly the deployment where
    // a config has to reach another window.
    await writeClipboard(text);
    copied = which;
  }

  function status(key: McpKeyView): { text: string; variant: "secondary" | "destructive" | "outline" } {
    if (key.revokedAt) return { text: i18n.t.dash.mcp.revoked, variant: "destructive" };
    if (new Date(key.expiresAt).getTime() <= Date.now()) return { text: i18n.t.dash.mcp.expired, variant: "outline" };
    return { text: i18n.t.dash.mcp.live, variant: "secondary" };
  }
</script>

<!--
  ⚠ NO HEADING OF ITS OWN ANY MORE. The host page wraps this in a Card whose
  header carries the title, the description and the key-count summary, so a
  second `<h2>` here printed the same two lines twice, one above the other.
-->
<section class="flex flex-col gap-4" data-testid="agent-access">
  <div class="flex flex-col gap-1.5">
    <span class="text-xs font-medium">{i18n.t.dash.mcp.endpoint}</span>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="agent-endpoint">{endpoint}</pre>
  </div>

  <!-- The host's OS, which it reported itself; the tab opens on it. -->
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-2">
      <span class="text-xs font-medium">{i18n.t.dash.mcp.osTitle}</span>
      {#if host.os}
        <Badge variant="outline" data-testid="agent-os-reported">{host.os}/{host.arch ?? "?"}</Badge>
      {/if}
    </div>
    <Tabs.Root bind:value={() => hostOs, (value) => (chosenOs = value as HostOs)}>
      <Tabs.List data-testid="agent-os">
        <Tabs.Trigger value="linux" data-testid="agent-os-linux">{i18n.t.dash.mcp.osLinux}</Tabs.Trigger>
        <Tabs.Trigger value="macos" data-testid="agent-os-macos">{i18n.t.dash.mcp.osMacos}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
    <p class="text-muted-foreground text-xs">{fmt(i18n.t.dash.mcp.osHint, { file: shellFile })}</p>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="agent-env-command">{envCommand}</pre>
    <div>
      <Button variant="outline" size="sm" onclick={() => copy(envCommand, "env")} data-testid="agent-env-copy">
        {copied === "env" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcp.copyEnv}
      </Button>
    </div>
  </div>

  <!-- The client the snippets are written for. Defaults from what the host reports. -->
  <div class="flex flex-col gap-1.5">
    <span class="text-xs font-medium">{i18n.t.dash.mcp.clientTitle}</span>
    <Tabs.Root bind:value={() => client, (value) => (chosen = value as ClientId)}>
      <Tabs.List data-testid="agent-client">
        <Tabs.Trigger value="codex" data-testid="agent-client-codex">{i18n.t.dash.mcp.clientCodex}</Tabs.Trigger>
        <Tabs.Trigger value="claude" data-testid="agent-client-claude">{i18n.t.dash.mcp.clientClaude}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="agent-client-config">{config}</pre>
    <p class="text-muted-foreground text-xs">{fmt(i18n.t.dash.mcp.configHint, { envVar: ENV_VAR })}</p>
    <div>
      <Button variant="outline" size="sm" onclick={() => copy(config, "config")} data-testid="agent-config-copy">
        {copied === "config" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcp.copyConfig}
      </Button>
    </div>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class="text-xs font-medium">{i18n.t.dash.mcp.handoffTitle}</span>
    <p class="text-muted-foreground text-xs">{i18n.t.dash.mcp.handoffHint}</p>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap"
      data-testid="agent-handoff">{handoff}</pre>
    <div>
      <Button variant="outline" size="sm" onclick={() => copy(handoff, "handoff")} data-testid="agent-handoff-copy">
        {copied === "handoff" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcp.copyHandoff}
      </Button>
    </div>
  </div>

  {#if canManage}
    <form class="flex flex-wrap items-end gap-2" onsubmit={mint} data-testid="agent-key-form">
      <div class="flex flex-col gap-1.5">
        <Label for="mcp-label">{i18n.t.dash.mcp.keyLabel}</Label>
        <Input id="mcp-label" bind:value={label} placeholder={i18n.t.dash.mcp.defaultLabel} data-testid="agent-key-label" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="mcp-expiry">{i18n.t.dash.mcp.keyExpiry}</Label>
        <Select.Root type="single" bind:value={expiresInDays}>
          <Select.Trigger id="mcp-expiry" class="w-32" data-testid="agent-key-expiry">
            {fmt(i18n.t.dash.mcp.days, { days: expiresInDays })}
          </Select.Trigger>
          <Select.Content>
            {#each ["30", "90", "180", "365"] as days (days)}
              <Select.Item value={days}>{fmt(i18n.t.dash.mcp.days, { days })}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="mcp-scope">{i18n.t.dash.mcp.keyScope}</Label>
        <Select.Root type="single" bind:value={scope}>
          <Select.Trigger id="mcp-scope" class="w-44" data-testid="agent-key-scope">
            {scope === "read" ? i18n.t.dash.mcp.scopeRead : i18n.t.dash.mcp.scopeReadWrite}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="read-write">{i18n.t.dash.mcp.scopeReadWrite}</Select.Item>
            <Select.Item value="read">{i18n.t.dash.mcp.scopeRead}</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      <Button type="submit" size="sm" disabled={minting} data-testid="agent-key-create">
        {i18n.t.dash.mcp.mint}
      </Button>
    </form>
  {/if}

  {#if error}
    <p class="text-destructive text-sm" data-testid="agent-key-error">{error}</p>
  {/if}

  <!--
    ⚠ A `DataTable`, NOT HAND-ROLLED ROWS. AGENTS.md makes the shared table
    mandatory for every list, and this one was a `{#each}` of bordered divs — so
    it had no sortable headers, no consistent empty state and no footer, and it
    drifted from every other list in the product for free.
  -->
  <!-- The two credentials are easy to confuse, and confusing them means minting a
       fleet-wide one when a machine-scoped one was wanted. One line, here, where
       somebody is already thinking about it. -->
  <p class="text-muted-foreground text-xs">
    {fmt(i18n.t.dash.mcp.fleetHint, { label: host.label })}
    <a class="underline" href="/access" data-testid="agent-fleet-link">{i18n.t.dash.mcpTokens.title}</a>
  </p>

  <div data-testid="agent-key-list">
    {#if loading}
      <p class="text-muted-foreground text-sm">{i18n.t.dash.mcp.loading}</p>
    {:else}
      <DataTable
        columns={keyColumns}
        rows={keys}
        getKey={(key) => key.id}
        empty={i18n.t.dash.mcp.empty}
        bind:sort={keySort}
        bind:page={keyPage}
        perPage={0}
        label={i18n.t.dash.mcp.title}
      >
        {#snippet row(key)}
          <Table.Cell class="font-medium">{key.label}</Table.Cell>
          <Table.Cell><code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{key.keyPrefix}…</code></Table.Cell>
          <Table.Cell class="text-muted-foreground">{key.scopes.join("+")}</Table.Cell>
          <Table.Cell><Badge variant={status(key).variant}>{status(key).text}</Badge></Table.Cell>
          <Table.Cell class="text-muted-foreground">
            {fmt(i18n.t.dash.mcp.until, { date: key.expiresAt.slice(0, 10) })}
          </Table.Cell>
          <Table.Cell>
            {#if canManage && !key.revokedAt}
              <Button
                variant="ghost"
                size="sm"
                onclick={() => revoke(key.id)}
                data-testid={`agent-key-revoke-${key.id}`}>{i18n.t.dash.mcp.revoke}</Button>
            {/if}
          </Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </div>
</section>

<!-- The one and only render of the plaintext. -->
<Dialog.Root
  open={revealed !== null}
  onOpenChange={(open) => {
    if (!open) revealed = null;
  }}>
  <Dialog.Content data-testid="agent-key-revealed">
    <Dialog.Header>
      <Dialog.Title>{i18n.t.dash.mcp.createdTitle}</Dialog.Title>
      <Dialog.Description>{i18n.t.dash.mcp.createdHint}</Dialog.Description>
    </Dialog.Header>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="agent-key-plaintext">{revealed?.key ?? ""}</pre>
    <p class="text-muted-foreground text-xs">{fmt(i18n.t.dash.mcp.createdEnvHint, { envVar: ENV_VAR })}</p>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => copy(revealed?.key ?? "", "key")} data-testid="agent-key-copy">
        {copied === "key" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcp.copyKey}
      </Button>
      <Button onclick={() => (revealed = null)} data-testid="agent-key-close">{i18n.t.dash.tokens.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
