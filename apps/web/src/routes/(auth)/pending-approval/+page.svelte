<script lang="ts">
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { getI18n } from "$lib/i18n";

  const i18n = getI18n();
</script>

<Card.Root>
  <Card.Header>
    <Card.Title role="heading" aria-level={1}>{i18n.t.auth.approvalPendingTitle}</Card.Title>
    <Card.Description>{i18n.t.auth.approvalPendingDesc}</Card.Description>
  </Card.Header>
  <Card.Footer>
    <Button class="w-full" onclick={() => goto("/login")}>{i18n.t.auth.backToSignIn}</Button>
  </Card.Footer>
</Card.Root>
