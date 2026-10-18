<script lang="ts">
  import { onMount } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { desktopLocalAgent, type LocalAgentStatus } from "#lib/desktop.js";
  import { getI18n } from "#lib/i18n/index.js";
  const i18n = getI18n();
  let status = $state<LocalAgentStatus | undefined>();
  let busy = $state(false);
  onMount(() => { void desktopLocalAgent()?.status().then(value => { status = value; }); });
  async function retry(): Promise<void> {
    busy = true;
    try { status = await desktopLocalAgent()?.retry(); await invalidateAll(); if (status?.phase === "ready") await goto("/"); }
    catch { status = { phase: "failed", code: "DESKTOP_LOCAL_AGENT_FAILED" }; }
    finally { busy = false; }
  }
</script>
{#if status}
  <Card.Root class="shrink-0" data-testid="desktop-local-host">
    <Card.Header><Card.Title>{i18n.t.desktop.localHost}</Card.Title></Card.Header>
    <Card.Content class="space-y-3">
      <p class="text-sm" role={status.phase === "failed" ? "alert" : undefined}>{status.phase === "ready" ? i18n.t.desktop.localAgentReady : i18n.t.desktop.localAgentFailed}</p>
      {#if status.phase !== "ready"}<Button disabled={busy} onclick={retry} data-testid="desktop-local-host-retry">{i18n.t.desktop.retryLocalAgent}</Button>{/if}
    </Card.Content>
  </Card.Root>
{/if}
