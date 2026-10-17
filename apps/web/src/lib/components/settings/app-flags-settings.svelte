<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import type { Capabilities } from "@podosoft/podokit-api-client";
  import { toast } from "svelte-sonner";
  import { appFlagCards } from "#lib/admin/app-flag-settings.js";
  import { api } from "#lib/api.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { Switch } from "#lib/components/ui/switch/index.js";
  import { getI18n } from "#lib/i18n/index.js";

  // The application's flags from app-flags.ts. They share the feature-flag
  // endpoint, so saving needs an administrator and applies at once, like the
  // switches on the Authentication tab.
  const i18n = getI18n();
  const cards = $derived(appFlagCards(i18n.t, page.data.capabilities as Capabilities | undefined));
  let saving = $state(false);

  async function toggle(flag: string, next: boolean): Promise<void> {
    saving = true;
    try {
      await api.put("/account/settings", { [flag]: next });
      await invalidateAll();
      toast.success(i18n.t.settings.saved);
    } catch {
      toast.error(i18n.t.settings.saveFailed);
    }
    saving = false;
  }
</script>

<section class="flex flex-col gap-3">
  <div>
    <h2 class="text-lg font-semibold">{i18n.t.settings.appFlags.title}</h2>
    <p class="text-muted-foreground text-sm">{i18n.t.settings.appFlags.subtitle}</p>
  </div>
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each cards as card (card.flag)}
      <Card.Root class="flex min-h-[8.5rem] flex-col gap-2 p-4" data-app-flag={card.flag}>
        <div class="flex items-start justify-between gap-3">
          <span class="font-medium break-words">{card.name}</span>
          <Switch
            aria-label={card.name}
            checked={card.on}
            disabled={saving || !card.available}
            onCheckedChange={(value) => toggle(card.flag, value === true)}
            class="shrink-0"
          />
        </div>
        <p class="text-muted-foreground flex-1 text-sm">{card.description}</p>
        <div class="mt-auto flex items-center gap-2 pt-1">
          <Badge variant={card.on ? "secondary" : "outline"} class="max-w-full gap-1.5">
            <span class={`size-1.5 shrink-0 rounded-full ${card.on ? "bg-green-500" : "bg-muted-foreground/40"}`}></span>
            <span class="truncate">
              {card.available
                ? card.on ? i18n.t.settings.enabled : i18n.t.settings.disabled
                : i18n.t.settings.appFlags.unavailable}
            </span>
          </Badge>
        </div>
      </Card.Root>
    {/each}
  </div>
</section>
