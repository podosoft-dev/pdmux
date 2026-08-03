<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { api } from "$lib/api";
  import { getI18n, fmt } from "$lib/i18n";
  import type { SessionUser } from "../../../app.d.ts";

  type Capabilities = { emailVerification: boolean };
  let { data }: { data: { user: SessionUser; capabilities: Capabilities } } = $props();
  const i18n = getI18n();

  // Unverified-user count — only when email verification is enabled.
  let unverifiedCount = $state<number | null>(null);
  $effect(() => {
    if (!data.capabilities.emailVerification) return;
    void (async () => {
      const { data: res } = await api.auth.admin.listUsers({
        query: { filterField: "emailVerified", filterOperator: "eq", filterValue: false, limit: 1 },
      });
      unverifiedCount = res?.total ?? 0;
    })();
  });
</script>

<div class="flex flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">{i18n.t.dashboard.title}</h1>
    <p class="text-muted-foreground text-sm">{fmt(i18n.t.dashboard.welcome, { name: data.user.name })}</p>
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    <Card.Root>
      <Card.Header><Card.Title>{i18n.t.dashboard.yourRole}</Card.Title></Card.Header>
      <Card.Content class="text-2xl font-semibold capitalize">{data.user.role ?? "user"}</Card.Content>
    </Card.Root>
    <Card.Root>
      <Card.Header><Card.Title>{i18n.t.dashboard.signedInAs}</Card.Title></Card.Header>
      <Card.Content class="text-muted-foreground truncate text-sm">{data.user.email}</Card.Content>
    </Card.Root>
    {#if data.capabilities.emailVerification}
      <Card.Root>
        <Card.Header><Card.Title>{i18n.t.dashboard.unverifiedUsers}</Card.Title></Card.Header>
        <Card.Content class="text-2xl font-semibold">{unverifiedCount ?? "—"}</Card.Content>
      </Card.Root>
    {/if}
  </div>
</div>
