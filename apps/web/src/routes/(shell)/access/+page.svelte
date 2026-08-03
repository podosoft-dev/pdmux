<script lang="ts">
  /**
   * The credential a coding CLI uses to work with THIS FLEET.
   *
   * ⚠ WHY IT IS ITS OWN ROUTE AND NOT PART OF /account. `account-page.svelte` is a
   * PodoKit-managed file reused whole, so editing it fights `podo update`. And
   * /admin/* is where an administrator configures the INSTALL — the fleet settings
   * page already wrote that argument down; this belongs beside /hosts, scoped the
   * same way.
   *
   * ⚠ WHY THE ENV VAR IS `PDMUX_MCP_TOKEN` AND NOT `PDMUX_MCP_KEY`. A person can
   * hold both kinds at once and one variable cannot carry both. The host page's own
   * spec asserts its blocks carry `PDMUX_MCP_KEY`, so sharing the name would put the
   * two screens' tests in each other's way for ever.
   *
   * ⚠ AND THE SECRET IS NEVER IN A CONFIG BLOCK. What gets copied out of this page
   * is the thing most likely to end up committed, so it carries a variable NAME and
   * a placeholder — the same rule `host-agent-access.svelte` states for its own.
   */
  import { onMount } from "svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Table from "$lib/components/ui/table";
  import DataTable, { type SortState } from "$lib/components/data-table.svelte";
  import { writeClipboard } from "@pdmux/ui";
  import { toast } from "svelte-sonner";
  import { mcpTokensApi } from "$lib/dashboard/api";
  import { causeMessage } from "$lib/dashboard/wording";
  import type { McpTokenPolicy, McpTokenView, MintedMcpToken } from "$lib/dashboard/types";
  import { fmt, getI18n } from "$lib/i18n";
  import ShellBreadcrumb from "$lib/dashboard/components/shell-breadcrumb.svelte";

  const i18n = getI18n();
  const ENV_VAR = "PDMUX_MCP_TOKEN";
  const TIERS = ["read", "operate", "admin"] as const;
  type Tier = (typeof TIERS)[number];

  let policy = $state<McpTokenPolicy | null>(null);
  let tokens = $state<McpTokenView[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  /** The plaintext, for exactly as long as the dialog is open. */
  let revealed = $state<MintedMcpToken | null>(null);
  let copied = $state<string | null>(null);

  let label = $state("");
  let expiresInDays = $state(90);
  let tier = $state<Tier>("operate");
  let sort = $state<SortState>({ key: "createdAt", dir: "desc" });
  /**
   * ⚠ ONE-BASED. `DataTable` pages with `slice((page - 1) * perPage, page * perPage)`,
   * so a zero here is `slice(-10, 0)` — an empty array for any list, which the table
   * then reports as "no tokens yet". Every token on this screen was invisible, and
   * the screen looked completely healthy while it happened.
   */
  let page = $state(1);

  const endpoint = $derived(typeof window === "undefined" ? "" : `${window.location.origin}/mcp`);
  const rank = (value: Tier): number => TIERS.indexOf(value);
  /** Above the ceiling is DISABLED, never hidden — see the fieldset below. */
  const allowed = (value: Tier): boolean => policy !== null && rank(value) <= rank(policy.ceiling);

  const codexConfig = $derived(
    `codex mcp add pdmux --url ${endpoint} --bearer-token-env-var ${ENV_VAR}`,
  );
  const claudeConfig = $derived(
    `{"mcpServers":{"pdmux":{"type":"http","url":"${endpoint}",\n  "headers":{"Authorization":"Bearer \${${ENV_VAR}}"}}}}`,
  );

  async function reload(): Promise<void> {
    loading = true;
    try {
      [policy, tokens] = await Promise.all([mcpTokensApi.policy(), mcpTokensApi.list()]);
      if (policy && !allowed(tier)) tier = policy.ceiling;
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    } finally {
      loading = false;
    }
  }

  onMount(reload);

  async function mint(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || label.trim().length === 0) return;
    busy = true;
    try {
      revealed = await mcpTokensApi.mint({ label: label.trim(), expiresInDays, tier });
      label = "";
      await reload();
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    } finally {
      busy = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    try {
      await mcpTokensApi.revoke(id);
      await reload();
    } catch (cause) {
      toast.error(causeMessage(cause, i18n.t));
    }
  }

  /**
   * `writeClipboard` rather than `navigator.clipboard` — a self-hosted pdmux reached
   * over plain http has none, and the fallback is what makes the button work there.
   * It resolves without a result, so the confirmation is optimistic.
   */
  async function copy(value: string, what: string): Promise<void> {
    await writeClipboard(value);
    copied = what;
    setTimeout(() => (copied = null), 1500);
  }

  /**
   * `Admin → Read` is its own state, and it has to be visible. A token whose owner
   * was demoted still authenticates; it just carries less. Showing only the granted
   * tier would be a promise the server no longer keeps.
   */
  function status(token: McpTokenView): { text: string; variant: "secondary" | "destructive" | "outline" } {
    if (token.revokedAt) return { text: i18n.t.dash.mcpTokens.revoked, variant: "destructive" };
    if (new Date(token.expiresAt).getTime() <= Date.now())
      return { text: i18n.t.dash.mcpTokens.expired, variant: "outline" };
    // ⚠ `null` MEANS THE OWNER HAS NO STANDING IN THIS SCOPE AT ALL, so the token
    // authenticates as nothing. Falling through to "Live" below would tell somebody a
    // credential works when it has already stopped.
    if (token.effectiveTier === null) return { text: i18n.t.dash.mcpTokens.noAccess, variant: "destructive" };
    if (token.effectiveTier !== token.tier)
      return {
        text: fmt(i18n.t.dash.mcpTokens.reduced, { tier: i18n.t.dash.mcpTokens.tier[token.effectiveTier].name }),
        variant: "outline",
      };
    if (token.expiringSoon) return { text: i18n.t.dash.mcpTokens.expiringSoon, variant: "outline" };
    return { text: i18n.t.dash.mcpTokens.live, variant: "secondary" };
  }

  const crumbs = $derived([
    { label: i18n.t.dash.title, href: "/", testId: "open-dashboard" },
    { label: i18n.t.dash.mcpTokens.title },
  ]);

  const columns = [
    { key: "label", label: i18n.t.dash.mcpTokens.colLabel, sortable: true },
    { key: "keyPrefix", label: i18n.t.dash.mcpTokens.colToken },
    { key: "tier", label: i18n.t.dash.mcpTokens.colTier },
    { key: "status", label: i18n.t.dash.mcpTokens.colStatus },
    { key: "lastUsedAt", label: i18n.t.dash.mcpTokens.colLastUsed, sortable: true },
    { key: "expiresAt", label: i18n.t.dash.mcpTokens.colExpires, sortable: true },
    { key: "actions", label: "" },
  ];
</script>

<svelte:head><title>{i18n.t.dash.mcpTokens.title}</title></svelte:head>

<!--
  ⚠ `data-pdmux-region="page"` AND ITS OWN SCROLL, like every other full-screen route.
  The shell places its children BY ROLE, so a div without the attribute is not placed at
  all — and without `min-h-0 overflow-y-auto` a grid child refuses to shrink below its
  content, so everything past the first card was simply cut off with no way to reach it.
  Measured on the deployed screen: the token list existed and could not be scrolled to.
-->
<div
  class="flex min-h-0 flex-col gap-4 overflow-y-auto p-6"
  data-testid="mcp-tokens"
  data-pdmux-region="page"
>
  <ShellBreadcrumb {crumbs} label={i18n.t.dash.breadcrumbLabel} />

  <div>
    <h1 class="text-2xl font-semibold">{i18n.t.dash.mcpTokens.title}</h1>
    <p class="text-muted-foreground text-sm">{i18n.t.dash.mcpTokens.blurb}</p>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>{i18n.t.dash.mcpTokens.endpointTitle}</Card.Title>
    </Card.Header>
    <Card.Content class="grid gap-3">
      <pre
        class="bg-muted overflow-x-auto rounded-md p-3 text-xs"
        data-testid="mcp-token-endpoint">{endpoint}</pre>

      <!-- Neither block contains the secret: a config block is the thing most likely
           to be committed, so it carries the variable name and nothing else. -->
      <pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs" data-testid="mcp-token-config">{codexConfig}</pre>
      <pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs" data-testid="mcp-token-config-claude">{claudeConfig}</pre>
      <p class="text-muted-foreground text-xs">{fmt(i18n.t.dash.mcpTokens.envHint, { envVar: ENV_VAR })}</p>
      <div>
        <Button variant="outline" size="sm" onclick={() => copy(codexConfig, "config")}>
          {copied === "config" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcpTokens.copyConfig}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>{i18n.t.dash.mcpTokens.newTitle}</Card.Title>
    </Card.Header>
    <Card.Content>
      <form class="grid gap-4" onsubmit={mint} data-testid="mcp-token-form">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-1.5">
            <Label for="token-label">{i18n.t.dash.mcpTokens.labelField}</Label>
            <Input id="token-label" bind:value={label} maxlength={64} placeholder="my laptop" required />
          </div>
          <div class="grid gap-1.5">
            <Label for="token-expiry">{i18n.t.dash.mcpTokens.expiryField}</Label>
            <select
              id="token-expiry"
              class="border-input bg-background h-9 rounded-md border px-3 text-sm"
              bind:value={expiresInDays}>
              {#each policy?.expiryDays ?? [] as days (days)}
                <option value={days}>{fmt(i18n.t.dash.mcpTokens.days, { days })}</option>
              {/each}
            </select>
          </div>
        </div>

        <fieldset class="grid gap-2">
          <legend class="text-sm font-medium">{i18n.t.dash.mcpTokens.tierField}</legend>
          {#each TIERS as option (option)}
            <label class="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="tier"
                class="mt-1"
                value={option}
                checked={tier === option}
                disabled={!allowed(option)}
                data-testid={`mcp-tier-${option}`}
                onchange={() => (tier = option)} />
              <span>
                <span class="font-medium">{i18n.t.dash.mcpTokens.tier[option].name}</span>
                {#if !allowed(option)}
                  <!-- ⚠ DISABLED, NEVER HIDDEN. Hiding the tiers makes the permission
                       model invisible and turns the eventual 403 into a surprise. -->
                  <span class="text-muted-foreground block text-xs" data-testid={`mcp-tier-${option}-blocked`}>
                    {i18n.t.dash.mcpTokens.aboveCeiling}
                  </span>
                {/if}
              </span>
            </label>
          {/each}
        </fieldset>

        <div class="bg-muted/50 grid gap-1 rounded-md p-3 text-sm" data-testid="mcp-tier-detail">
          <p class="font-medium">{fmt(i18n.t.dash.mcpTokens.canDo, { tier: i18n.t.dash.mcpTokens.tier[tier].name })}</p>
          <ul class="grid gap-0.5">
            {#each i18n.t.dash.mcpTokens.tier[tier].can as line (line)}
              <li>✓ {line}</li>
            {/each}
            {#each i18n.t.dash.mcpTokens.tier[tier].cannot as line (line)}
              <li class="text-muted-foreground">✗ {line}</li>
            {/each}
          </ul>
        </div>

        <div class="flex justify-end">
          <!-- Disabled while the policy is still loading: the tier defaults to `operate`, and
               submitting before the ceiling is known would ask for a tier the server then
               refuses. The server is still the authority; this only stops the pointless 403. -->
          <Button
            type="submit"
            disabled={loading || busy || policy === null || label.trim().length === 0}
            data-testid="mcp-token-create">
            {i18n.t.dash.mcpTokens.create}
          </Button>
        </div>
      </form>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>{i18n.t.dash.mcpTokens.listTitle}</Card.Title>
    </Card.Header>
    <Card.Content>
      {#if loading}
        <p class="text-muted-foreground text-sm">{i18n.t.dash.mcpTokens.loading}</p>
      {:else}
        <DataTable
          {columns}
          rows={tokens}
          getKey={(token) => token.id}
          empty={i18n.t.dash.mcpTokens.empty}
          bind:sort
          bind:page
          perPage={10}
          label={i18n.t.dash.mcpTokens.listTitle}>
          {#snippet row(token)}
            <Table.Cell class="font-medium">{token.label}</Table.Cell>
            <Table.Cell
              ><code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{token.keyPrefix}…</code></Table.Cell>
            <Table.Cell class="text-muted-foreground">{i18n.t.dash.mcpTokens.tier[token.tier].name}</Table.Cell>
            <Table.Cell><Badge variant={status(token).variant}>{status(token).text}</Badge></Table.Cell>
            <Table.Cell class="text-muted-foreground">{token.lastUsedAt?.slice(0, 10) ?? "—"}</Table.Cell>
            <Table.Cell class="text-muted-foreground">{token.expiresAt.slice(0, 10)}</Table.Cell>
            <Table.Cell>
              {#if !token.revokedAt}
                <Button variant="ghost" size="sm" onclick={() => revoke(token.id)} data-testid={`mcp-token-revoke-${token.id}`}>
                  {i18n.t.dash.mcpTokens.revoke}
                </Button>
              {/if}
            </Table.Cell>
          {/snippet}
        </DataTable>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<!-- The one and only render of the plaintext. `revealed` is nulled on close and is
     never written anywhere that outlives this dialog. -->
<Dialog.Root
  open={revealed !== null}
  onOpenChange={(open) => {
    if (!open) revealed = null;
  }}>
  <Dialog.Content data-testid="mcp-token-revealed">
    <Dialog.Header>
      <Dialog.Title>{i18n.t.dash.mcpTokens.createdTitle}</Dialog.Title>
      <Dialog.Description>{i18n.t.dash.mcpTokens.createdHint}</Dialog.Description>
    </Dialog.Header>
    <pre
      class="bg-muted overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap"
      data-testid="mcp-token-plaintext">{revealed?.token ?? ""}</pre>
    <p class="text-muted-foreground text-xs">{fmt(i18n.t.dash.mcpTokens.createdEnvHint, { envVar: ENV_VAR })}</p>
    <p class="text-muted-foreground text-xs">{i18n.t.dash.mcpTokens.createdReach}</p>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => copy(revealed?.token ?? "", "token")} data-testid="mcp-token-copy">
        {copied === "token" ? i18n.t.dash.tokens.copied : i18n.t.dash.mcpTokens.copyToken}
      </Button>
      <Button onclick={() => (revealed = null)} data-testid="mcp-token-close">{i18n.t.dash.tokens.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
