<script lang="ts">
  /**
   * What a dark pane says when its host's machine is the reason — and the one button that
   * would bring it back.
   *
   * It replaces the plain "not reachable" line only for hosts a provider manages; a host
   * without a machine keeps exactly the words it had. The button is the state's default
   * (wake, start) and nothing else: a pane is not where a machine is shut down, and every
   * other change is one click away in the header's power menu.
   */
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import SunIcon from "@lucide/svelte/icons/sun";
  import PlayIcon from "@lucide/svelte/icons/play";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { elapsedSeconds, powerItems, vmPhase } from "./power";
  import { useVmPower } from "./power-controller.svelte";

  let {
    host,
    canManage,
    now,
    compact = false,
  }: {
    host: HostView | undefined;
    canManage: boolean;
    now: number;
    compact?: boolean;
  } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  const vm = $derived(host?.vm);
  const phase = $derived(vm ? vmPhase(vm) : null);
  const primary = $derived(vm ? powerItems(vm, canManage).find((item) => item.kind === "primary" && item.action === "start") : undefined);
  const sending = $derived(Boolean(host && power?.sending[host.id]));

  const message = $derived.by(() => {
    if (!vm) return i18n.t.pdmux.pane.unreachable;
    switch (phase) {
      case "asleep": return i18n.t.vm.veil.asleep;
      case "off": return i18n.t.vm.veil.off;
      case "paused": return i18n.t.vm.veil.paused;
      case "missing": return i18n.t.vm.veil.missing;
      case "busy": {
        const operation = vm.operation;
        if (!operation) return "";
        return fmt(i18n.t.vm.progress, {
          operation: i18n.t.vm.operation[operation.action],
          name: operation.requestedBy.name ?? i18n.t.vm.someone,
          seconds: elapsedSeconds(vm, now),
        });
      }
      // Running at the provider, but its agent has not reported yet: it is on its way.
      default: return vm.state === "running" ? i18n.t.vm.veil.waiting : i18n.t.pdmux.pane.unreachable;
    }
  });
  const errorText = $derived(vm?.error && !vm.operation ? power?.describe(null, vm.error.code) ?? vm.error.code : null);
</script>

<div class="flex max-w-xs flex-col items-center gap-2" data-testid="vm-veil" data-pdmux-vm-phase={phase ?? "none"}>
  {#if vm}
    {#if phase === "busy"}
      <LoaderCircleIcon class="size-5 animate-spin" aria-hidden="true" />
    {:else if phase === "asleep"}
      <MoonIcon class="size-5" aria-hidden="true" />
    {:else if phase === "off" || phase === "missing"}
      <PowerOffIcon class="size-5" aria-hidden="true" />
    {/if}
    <p class="text-foreground text-sm" data-testid="vm-veil-message">{message}</p>
    <p class="text-muted-foreground text-xs">{vm.name} · {i18n.t.vm.state[vm.state]}</p>
    {#if errorText}
      <p class="text-destructive text-xs" data-testid="vm-veil-error">{errorText}</p>
    {/if}
    {#if primary && host}
      <Button
        size={compact ? "lg" : "sm"}
        class={compact ? "min-h-11" : ""}
        disabled={sending}
        data-testid="vm-veil-action"
        data-pdmux-vm-action={primary.action}
        onclick={() => power?.choose(host, primary)}
      >
        {#if sending}
          <LoaderCircleIcon class="size-4 animate-spin" />
        {:else if primary.label === "wake"}
          <SunIcon class="size-4" />
        {:else}
          <PlayIcon class="size-4" />
        {/if}
        {i18n.t.vm.action[primary.label]}
      </Button>
    {/if}
  {:else}
    <p data-testid="vm-veil-message">{message}</p>
  {/if}
</div>
