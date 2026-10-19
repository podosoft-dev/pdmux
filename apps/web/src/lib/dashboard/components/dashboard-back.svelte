<script lang="ts">
  import { goto } from "$app/navigation";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import { Button } from "#lib/components/ui/button/index.js";
  import { getI18n } from "#lib/i18n/index.js";
  import { selectView } from "../mobile-view.svelte.ts";
  import { useShellState } from "../shell-state.svelte.ts";

  const i18n = getI18n();
  const shell = useShellState();

  async function back(event: MouseEvent): Promise<void> {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    await goto("/");
    selectView(shell, "terminal");
  }
</script>

<Button href="/" variant="outline" size="sm" class="size-11 shrink-0 p-0 sm:h-7 sm:w-auto sm:px-2.5 pointer-coarse:h-11" aria-label={i18n.t.dash.backToDashboard} data-testid="open-dashboard" onclick={back}>
  <ArrowLeftIcon class="size-4" aria-hidden="true" /><span class="hidden sm:inline">{i18n.t.dash.title}</span>
</Button>
