<script lang="ts">
  import { createAuthClient } from "better-auth/client";
  import { electronProxyClient } from "@better-auth/electron/proxy";
  import { DESKTOP_SCHEME } from "@pdmux/desktop-protocol";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
  const i18n = getI18n(); let code = $state(""); let failed = $state(false); let busy = $state(false);
  async function approve(): Promise<void> {
    busy = true; failed = false;
    try {
      const client = createAuthClient({ plugins: [electronProxyClient({ clientID: "pdmux-desktop", protocol: DESKTOP_SCHEME })] });
      const result = await client.electron.transferUser({ fetchOptions: { query: data.query } });
      if (result.error || !result.data?.electron_authorization_code) throw new Error("DESKTOP_AUTH_FAILED");
      code = client.electron.getAuthorizationCode() ?? "";
      if (!code) throw new Error("DESKTOP_AUTH_CODE_MISSING");
      window.location.href = `${DESKTOP_SCHEME}://auth/callback#token=${encodeURIComponent(code)}`;
    } catch { failed = true; } finally { busy = false; }
  }
</script>
<svelte:head><title>{i18n.t.desktop.title} · PDMux</title></svelte:head>
<div class="mx-auto flex w-full max-w-xl flex-1 items-center p-6">
  <Card.Root class="w-full"><Card.Header><Card.Title>{i18n.t.desktop.title}</Card.Title><Card.Description>{i18n.t.desktop.sharing}</Card.Description></Card.Header>
    <Card.Content class="space-y-4"><p>{data.userName}</p><Button disabled={busy} onclick={approve}>{i18n.t.desktop.complete}</Button>
      {#if code}<p class="text-muted-foreground text-sm">{i18n.t.desktop.code}</p><code class="block break-all rounded-md border p-3 select-all">{code}</code>{/if}
      {#if failed}<p class="text-destructive" role="alert">{i18n.t.desktop.failed}</p>{/if}
    </Card.Content>
  </Card.Root>
</div>
