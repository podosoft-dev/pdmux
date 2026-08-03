<script lang="ts">
  /**
   * The fleet's own settings — cadence, stored history, caps, lists, and the sweep.
   *
   * WHY IT IS IN THE PRODUCT SHELL AND NOT THE ADMIN CONSOLE. These settings are
   * per-FLEET, not per-installation: the API files every one of them under the scope
   * `resolveScopeId(session)` answers (an organization, or `personal:<userId>` when
   * there is none), so two accounts on the same server legitimately hold different
   * values. `/admin/*` is where an administrator configures the INSTALL — SMTP,
   * providers, sign-up approval — and putting a per-scope document there would say it
   * was one document. It belongs beside `/hosts`, which is scoped the same way and is
   * the screen these numbers are actually about.
   *
   * ⚠ EVERY FIELD CARRIES ITS CONSEQUENCE, not just its name. A number with nothing
   * attached is a number people guess at, and each of these is spent on somebody
   * else's machine: a heartbeat is traffic per host, a metric step is ~17k rows a day,
   * a git interval is a repository walk. The reasoning is the API's own field comments,
   * moved onto the screen through i18n rather than left where only a reader of the
   * server source would find it.
   *
   * ⚠ AND ONE OF THEM DELETES MACHINES. `staleHostRetentionDays` is drawn apart from
   * everything above it, says what is lost by cascade, and cannot be armed without a
   * typed confirmation that names the hosts it would take. `0` is off and turning it
   * off is deliberately NOT gated — a control that is harder to switch off than on is
   * the wrong way round.
   */
  import { untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { fmt, getI18n } from "$lib/i18n";
  import ConfirmDialog from "$lib/dashboard/components/confirm-dialog.svelte";
  import ShellBreadcrumb from "$lib/dashboard/components/shell-breadcrumb.svelte";
  import { errorCode, fleetApi } from "$lib/dashboard/api";
  import {
    FLEET_FIELD_GROUPS,
    FLEET_NUMBER_BOUNDS,
    type FieldError,
    type FleetDraft,
    type FleetGroup,
    type FleetListKey,
    type FleetNumberKey,
    type SweepCandidate,
    armsHostSweep,
    draftFrom,
    hostsPastWindow,
    reviewDraft,
    savedNumber,
  } from "$lib/dashboard/fleet-settings";
  import { useShellState } from "$lib/dashboard/shell-state.svelte";
  import type { FleetSettingsView } from "$lib/dashboard/types";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  // The live fleet, for the one question this screen has to answer about it: which
  // hosts a proposed sweep window would delete. Read from the shell's feed rather than
  // fetched again — it is already polling, and two lists of one fleet disagree.
  const shell = useShellState();

  /**
   * What the server last said, and what is being typed over it.
   *
   * `untrack` because the loader re-runs on a locale switch and after every save: a
   * reactive seed would throw away half-typed edits the moment anything invalidated.
   * The save path replaces both from the PUT's own answer, which is the only thing
   * that should ever move them.
   */
  let saved = $state<FleetSettingsView>(untrack(() => data.fleet));
  let draft = $state<FleetDraft>(untrack(() => draftFrom(data.fleet)));
  let saving = $state(false);

  const review = $derived(reviewDraft(saved, draft));
  const invalid = $derived(Object.keys(review.errors).length > 0);
  const dirty = $derived(Object.keys(review.patch).length > 0);

  /**
   * Nothing may be written when we could not read.
   *
   * `fleetOk: false` means the loader fell back to the shipped defaults, and a form
   * seeded from them looks exactly like a form seeded from the operator's values —
   * pressing Save would write defaults over settings nobody chose to change. The other
   * half of the gate is `canManage`, which the API answers because the rule needs the
   * active organization; the screen draws no control that would earn a 403.
   */
  const blocked = $derived(!data.canManage || !data.fleetOk);
  const canSave = $derived(!blocked && dirty && !invalid && !saving);

  const crumbs = $derived([
    { label: i18n.t.dash.title, href: "/", testId: "open-dashboard" },
    { label: i18n.t.dash.fleet.title },
  ]);

  /** Every group but the sweep — that one is drawn apart, at the bottom. */
  const REGULAR_GROUPS = FLEET_FIELD_GROUPS.filter((group) => group.id !== "sweep");
  const SWEEP_KEY = "staleHostRetentionDays";

  // Split by kind rather than branching inside the loop: `filter` with a type predicate
  // narrows, so the number fields can look up their own bounds without a cast. The
  // groups are homogeneous anyway, so this also preserves the declared order.
  function numberKeysOf(group: FleetGroup): FleetNumberKey[] {
    return group.keys.filter(
      (key): key is FleetNumberKey => key !== "gitRoots" && key !== "usageProviders",
    );
  }

  function listKeysOf(group: FleetGroup): FleetListKey[] {
    return group.keys.filter(
      (key): key is FleetListKey => key === "gitRoots" || key === "usageProviders",
    );
  }

  function errorText(key: FleetNumberKey, reason: FieldError): string {
    if (reason === "required") return i18n.t.dash.fleet.error.required;
    if (reason === "integer") return i18n.t.dash.fleet.error.integer;
    const bounds = FLEET_NUMBER_BOUNDS[key];
    return fmt(i18n.t.dash.fleet.error.range, { min: bounds.min, max: bounds.max });
  }

  function message(cause: unknown): string {
    const code = errorCode(cause);
    if (code === "FORBIDDEN") return i18n.t.dash.error.forbidden;
    if (code === "NETWORK_ERROR") return i18n.t.dash.error.offline;
    return i18n.t.dash.error.generic;
  }

  // --- the sweep gate -------------------------------------------------------
  let sweepOpen = $state(false);
  let sweepDays = $state(0);
  let sweepAtRisk = $state<SweepCandidate[]>([]);

  /** What the field says right now, for the note under it — 0 while it is unreadable. */
  const sweepValue = $derived(review.patch[SWEEP_KEY] ?? savedNumber(saved, SWEEP_KEY));

  /**
   * Save, unless this save arms the sweep — then ask first.
   *
   * The at-risk list is computed HERE rather than in a `$derived`: it is a snapshot of
   * a fleet that keeps polling, and the dialog must show the machines it named when it
   * opened rather than a list that shifts under the confirmation.
   */
  function requestSave(): void {
    if (!canSave) return;
    const next = review.patch[SWEEP_KEY];
    if (next !== undefined && armsHostSweep(savedNumber(saved, SWEEP_KEY), next)) {
      sweepDays = next;
      sweepAtRisk = hostsPastWindow(shell.feed.hosts, next, Date.now());
      sweepOpen = true;
      return;
    }
    void commit();
  }

  async function commit(): Promise<void> {
    saving = true;
    try {
      const next = await fleetApi.updateSettings(review.patch);
      saved = next;
      draft = draftFrom(next);
      toast.success(i18n.t.dash.fleet.saved);
      // The shell's loader carries these settings to the screens that react to them —
      // `/hosts` draws its removal warnings from `staleHostRetentionDays`. A
      // client-side navigation does not re-run a layout load on its own, so without
      // this the list would keep warning by the old window until a full reload.
      await invalidateAll();
    } catch (cause: unknown) {
      toast.error(message(cause));
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>{i18n.t.dash.fleet.title} · pdmux</title></svelte:head>

<!-- The shell owns the viewport, so this column owns its own scrolling (ARCHITECTURE §7).
     ⚠ EVERY CARD BELOW CARRIES `shrink-0`, AND IT IS NOT COSMETIC. A flex column
     shrinks its children by default, and the shadcn `Card` is `overflow-hidden` —
     so a card taller than the space left does not push this container into
     scrolling, it silently CLIPS its own fields. Measured on this screen before
     the class was added: the first group reported scrollHeight 434 against
     clientHeight 160, one field of four was reachable, and the page did not
     scroll at all. Most of the settings this screen exists to expose could not
     be touched. -->
<div
  class="flex min-h-0 flex-col gap-4 overflow-y-auto p-6"
  data-testid="fleet-settings-panel"
  data-pdmux-region="page"
>
  <ShellBreadcrumb {crumbs} label={i18n.t.dash.breadcrumbLabel} />

  <div>
    <h1 class="text-2xl font-semibold" data-testid="fleet-settings-title">{i18n.t.dash.fleet.title}</h1>
    <p class="text-muted-foreground text-sm">{i18n.t.dash.fleet.subtitle}</p>
    <!-- Why this screen is here and not in the admin console, said once on the screen
         itself: these values belong to this fleet, not to the installation. -->
    <p class="text-muted-foreground mt-1 text-xs">{i18n.t.dash.fleet.scopeNote}</p>
  </div>

  {#if !data.fleetOk}
    <Alert.Root variant="destructive" data-testid="fleet-unavailable">
      <TriangleAlertIcon aria-hidden="true" />
      <Alert.Description>{i18n.t.dash.fleet.unavailable}</Alert.Description>
    </Alert.Root>
  {:else if !data.canManage}
    <Alert.Root data-testid="fleet-readonly">
      <Alert.Description>{i18n.t.dash.fleet.readOnly}</Alert.Description>
    </Alert.Root>
  {/if}

  {#each REGULAR_GROUPS as group (group.id)}
    <Card.Root class="shrink-0" data-testid={`fleet-group-${group.id}`}>
      <Card.Header>
        <Card.Title>{i18n.t.dash.fleet.group[group.id].title}</Card.Title>
        <Card.Description>{i18n.t.dash.fleet.group[group.id].blurb}</Card.Description>
      </Card.Header>
      <Card.Content class="grid gap-5">
        {#each numberKeysOf(group) as key (key)}
          {@render numberField(key)}
        {/each}
        {#each listKeysOf(group) as key (key)}
          {@render listField(key)}
        {/each}
      </Card.Content>
    </Card.Root>
  {/each}

  <!--
    THE SWEEP, APART FROM EVERYTHING ABOVE IT.

    Not a styling flourish: every other setting on this page changes what is collected
    or how long a row is kept, and this one DELETES THE HOST — with its agent tokens,
    its enrollment codes, its services and its history, by cascade. Sitting it beside
    `metricRetentionDays` would say the two were the same kind of number. The border and
    the icon are the same signal the delete dialogs in this product use.
  -->
  <Card.Root class="border-destructive/50 shrink-0" data-testid="fleet-group-sweep">
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
        {i18n.t.dash.fleet.group.sweep.title}
      </Card.Title>
      <Card.Description>{i18n.t.dash.fleet.group.sweep.blurb}</Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-3">
      {@render numberField(SWEEP_KEY)}
      <p class="text-muted-foreground text-xs" data-testid="fleet-sweep-state">
        {sweepValue > 0 ? i18n.t.dash.fleet.sweep.onNote : i18n.t.dash.fleet.sweep.offNote}
      </p>
      <p class="text-muted-foreground text-xs">{i18n.t.dash.fleet.sweep.neverSwept}</p>
    </Card.Content>
  </Card.Root>

  <!-- Sticky inside this column, not the page: fourteen fields is more than one screen,
       and a Save that scrolled away would be found by scrolling back past every field
       the operator had just decided about. The column is the scroller (see above), so
       `bottom-0` pins to its edge rather than the viewport's. -->
  <div class="bg-background sticky bottom-0 -mx-6 -mb-6 flex items-center gap-2 border-t px-6 py-3">
    <Button disabled={!canSave} data-testid="fleet-save" onclick={requestSave}>
      {saving ? i18n.t.dash.fleet.saving : i18n.t.dash.fleet.save}
    </Button>
    <Button
      variant="ghost"
      disabled={!dirty || saving}
      data-testid="fleet-reset"
      onclick={() => (draft = draftFrom(saved))}
    >
      {i18n.t.dash.fleet.reset}
    </Button>
  </div>
</div>

{#snippet numberField(key: FleetNumberKey)}
  {@const bounds = FLEET_NUMBER_BOUNDS[key]}
  {@const reason = review.errors[key]}
  <div class="grid gap-1">
    <Label for={`fleet-${key}`}>{i18n.t.dash.fleet.field[key].label}</Label>
    <p class="text-muted-foreground text-xs">{i18n.t.dash.fleet.field[key].why}</p>
    <div class="flex flex-wrap items-center gap-2">
      <!-- `type="text"` with a numeric keypad hint, NOT `type="number"`: a number input
           hands back an empty string for anything it considers unparsable, so "12x"
           would arrive here as "" and be reported as a missing value rather than as the
           thing that was actually typed. The bounds are enforced by `parseNumberField`,
           which is where they can be tested. -->
      <Input
        id={`fleet-${key}`}
        type="text"
        inputmode="numeric"
        class="max-w-40"
        bind:value={draft[key]}
        disabled={blocked}
        aria-invalid={reason === undefined ? undefined : "true"}
        aria-describedby={`fleet-${key}-bounds`}
        data-testid={`fleet-field-${key}`}
      />
      <span class="text-muted-foreground text-xs" id={`fleet-${key}-bounds`} data-testid={`fleet-bounds-${key}`}>
        {fmt(i18n.t.dash.fleet.bounds, { min: bounds.min, max: bounds.max })}
      </span>
    </div>
    {#if reason !== undefined}
      <!-- Beside the field, before the request. The API would answer 400 for the same
           value, but a toast that says "something went wrong" three fields away from
           the one that is wrong is not a message about this field. -->
      <p class="text-destructive text-xs" data-testid={`fleet-error-${key}`}>{errorText(key, reason)}</p>
    {/if}
  </div>
{/snippet}

{#snippet listField(key: FleetListKey)}
  <div class="grid gap-1">
    <Label for={`fleet-${key}`}>{i18n.t.dash.fleet.field[key].label}</Label>
    <p class="text-muted-foreground text-xs">{i18n.t.dash.fleet.field[key].why}</p>
    <Input
      id={`fleet-${key}`}
      bind:value={draft[key]}
      disabled={blocked}
      data-testid={`fleet-field-${key}`}
    />
    <p class="text-muted-foreground text-xs">{i18n.t.dash.fleet.listHint}</p>
  </div>
{/snippet}

<!-- Arming the sweep is the one save on this page that destroys something, so it takes
     the product's own typing gate. What can be got wrong here is the NUMBER OF DAYS —
     the same reasoning as the bulk delete, which retypes a count — so that is what is
     typed, above a list of the machines this window would take today. -->
<ConfirmDialog
  bind:open={sweepOpen}
  title={i18n.t.dash.fleet.sweep.armTitle}
  warning={i18n.t.dash.fleet.sweep.armWarning}
  label={String(sweepDays)}
  confirmLabel={i18n.t.dash.fleet.sweep.armConfirm}
  testId="fleet-sweep-confirm"
  details={sweepDetails}
  onConfirm={commit}
/>

{#snippet sweepDetails()}
  {#if sweepAtRisk.length > 0}
    <p data-testid="fleet-sweep-at-risk">
      {fmt(i18n.t.dash.fleet.sweep.atRisk, { count: sweepAtRisk.length, days: sweepDays })}
    </p>
    <ul class="mt-1 list-disc ps-5">
      {#each sweepAtRisk as host (host.id)}
        <li data-testid={`fleet-sweep-host-${host.label}`}>{host.label}</li>
      {/each}
    </ul>
  {:else}
    <p data-testid="fleet-sweep-at-risk-none">
      {fmt(i18n.t.dash.fleet.sweep.atRiskNone, { days: sweepDays })}
    </p>
  {/if}
  <p class="text-muted-foreground mt-2">{fmt(i18n.t.dash.fleet.sweep.typeDays, { days: sweepDays })}</p>
{/snippet}
