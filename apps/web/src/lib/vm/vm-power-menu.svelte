<script lang="ts">
  /**
   * The power control in a terminal pane's header, for a host whose machine a provider manages.
   *
   * ⚠ EVERY PANE ON THE MACHINE DRAWS THIS FROM THE SAME `HostView.vm`. That is the whole of the
   * sync: the icon, the state word and the progress line come from the server's row, so a change
   * started from one pane — or by somebody else — shows in all of them on the next fleet read.
   * Nothing here flips a state locally; the only local fact is "this screen sent a request and
   * has no answer yet", which locks the menu against a double press.
   */
  import PowerIcon from "@lucide/svelte/icons/power";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SunIcon from "@lucide/svelte/icons/sun";
  import ZapIcon from "@lucide/svelte/icons/zap";
  import RefreshCcwIcon from "@lucide/svelte/icons/refresh-ccw";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import type { Component } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import type { HostView } from "#lib/dashboard/types.js";
  import { fmt, getI18n } from "#lib/i18n/index.js";
  import { elapsedSeconds, powerItems, vmPhase, type PowerItem } from "./power";
  import { useVmPower } from "./power-controller.svelte";

  let {
    host,
    canManage,
    now,
    buttonClass = "size-7",
  }: {
    host: HostView & { vm: NonNullable<HostView["vm"]> };
    canManage: boolean;
    now: number;
    buttonClass?: string;
  } = $props();

  const i18n = getI18n();
  const power = useVmPower();
  const vm = $derived(host.vm);
  const phase = $derived(vmPhase(vm));
  const items = $derived(powerItems(vm, canManage));
  const sending = $derived(Boolean(power?.sending[host.id]));
  const ICONS: Record<PowerItem["label"], Component> = {
    wake: SunIcon,
    start: PlayIcon,
    hibernate: MoonIcon,
    shutdown: PowerOffIcon,
    reboot: RotateCwIcon,
    stop: ZapIcon,
    reset: RefreshCcwIcon,
  };

  const progress = $derived.by(() => {
    const operation = vm.operation;
    if (!operation) return null;
    const values = {
      operation: i18n.t.vm.operation[operation.action],
      name: operation.requestedBy.name ?? i18n.t.vm.someone,
      seconds: elapsedSeconds(vm, now),
    };
    const step = operation.step ? (i18n.t.vm.step as Record<string, string>)[operation.step] : undefined;
    return step ? fmt(i18n.t.vm.progressStep, { ...values, step }) : fmt(i18n.t.vm.progress, values);
  });
  const errorText = $derived(vm.error && !vm.operation ? power?.describe(null, vm.error.code) ?? vm.error.code : null);
  const label = $derived(`${fmt(i18n.t.vm.menuFor, { name: vm.name })} · ${i18n.t.vm.state[vm.state]}`);
  const firstDanger = $derived(items.findIndex((item) => item.kind === "danger"));
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={`${buttonClass} pdmux-vm-power`}
        title={progress ?? label}
        aria-label={progress ?? label}
        data-pdmux-vm-power
        data-pdmux-vm-state={vm.state}
        data-pdmux-vm-phase={phase}
      >
        {#if phase === "busy" || sending}
          <LoaderCircleIcon class="size-4 animate-spin" />
        {:else if phase === "error"}
          <TriangleAlertIcon class="size-4 text-destructive" />
        {:else if phase === "asleep"}
          <MoonIcon class="size-4 text-muted-foreground" />
        {:else if phase === "off" || phase === "missing"}
          <PowerOffIcon class="size-4 text-muted-foreground" />
        {:else}
          <PowerIcon class="size-4" />
        {/if}
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-72" data-testid="vm-power-menu">
    <DropdownMenu.Label class="flex flex-col gap-0.5">
      <span class="text-sm" data-testid="vm-power-state">{i18n.t.vm.state[vm.state]}</span>
      <span class="text-muted-foreground text-xs font-normal">{vm.provider.name} · {vm.location} · {vm.externalId}</span>
    </DropdownMenu.Label>
    {#if progress}
      <p class="text-muted-foreground px-2 py-1.5 text-xs" data-testid="vm-power-progress">{progress}</p>
    {:else if errorText}
      <p class="text-destructive px-2 py-1.5 text-xs" data-testid="vm-power-error">{errorText}</p>
    {/if}
    {#if items.length > 0}
      <DropdownMenu.Separator />
    {/if}
    {#each items as item, index (item.action)}
      {#if index === firstDanger && index > 0}
        <DropdownMenu.Separator />
      {/if}
      {@const Icon = ICONS[item.label]}
      <DropdownMenu.Item
        disabled={sending}
        class={item.kind === "danger" ? "text-destructive focus:text-destructive" : ""}
        data-pdmux-vm-action={item.action}
        data-pdmux-vm-kind={item.kind}
        onSelect={() => power?.choose(host, item)}
      >
        <Icon class="mr-2 size-4 shrink-0" />
        <span class="flex min-w-0 flex-col">
          <span class={item.kind === "primary" ? "font-medium" : ""}>{i18n.t.vm.action[item.label]}</span>
          <span class="text-muted-foreground text-xs">{i18n.t.vm.hint[item.label]}</span>
        </span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
