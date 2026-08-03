<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
  // The OAuth provider redirects here with the authorization request in the query
  // (and a pending-request cookie). Show what's being requested, then approve/deny.
  const clientId = $derived(page.url.searchParams.get("client_id") ?? "");
  const scopes = $derived((page.url.searchParams.get("scope") ?? "").split(/[+\s]/).filter(Boolean));
  let busy = $state(false);

  async function decide(accept: boolean): Promise<void> {
    busy = true;
    // The authorization request is carried in the signed query params we were
    // redirected here with; forward them verbatim so the server can validate and
    // restore it. Credentials carry the user's session. The response says where next.
    const res = await fetch(`/api/auth/oauth2/consent${page.url.search}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; redirectURI?: string };
    const next = data.url ?? data.redirectURI;
    if (next) window.location.href = next;
    else busy = false;
  }
</script>

<div class="mx-auto flex min-h-[70vh] max-w-md items-center">
  <Card.Root class="w-full">
    <Card.Header>
      <Card.Title>{i18n.t.consent.title}</Card.Title>
      <Card.Description>{i18n.t.consent.subtitle}</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <div class="text-sm">
        <p class="font-medium">{clientId}</p>
        {#if scopes.length}
          <p class="text-muted-foreground mt-1">{i18n.t.consent.requests}</p>
          <ul class="text-muted-foreground mt-1 list-inside list-disc">
            {#each scopes as s (s)}<li>{s}</li>{/each}
          </ul>
        {/if}
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onclick={() => decide(false)}>{i18n.t.consent.deny}</Button>
        <Button disabled={busy} onclick={() => decide(true)}>{i18n.t.consent.allow}</Button>
      </div>
    </Card.Content>
  </Card.Root>
</div>
