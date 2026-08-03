<script lang="ts">
  import AccountPage from "$lib/components/account-page.svelte";
  import type { Capabilities } from "@podosoft/podokit-api-client";
  import type { SessionUser } from "../../../../app.d.ts";

  let {
    data,
  }: {
    data: { user: SessionUser; currentSessionId: string | null; capabilities: Capabilities };
  } = $props();
</script>

<AccountPage {data} accountPath="/admin/account" returnPath="/admin" />
