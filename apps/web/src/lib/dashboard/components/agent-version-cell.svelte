<script lang="ts">
  /**
   * What a host's agent version says, in one badge plus the outcome of the last
   * update attempt.
   *
   * The badge is the VERDICT, not the number: `0.4.1` tells a reader nothing unless
   * they also know what is published for that host's platform, and that comparison
   * is per (os, arch) — resolved by the server, spelled here.
   *
   * `incompatible` is the only red one. Everything else is advisory: a host that is
   * behind still works, and painting the whole fleet red the day a release lands
   * teaches people to ignore the column.
   *
   * The last-update line is here rather than in a log because a rollout that failed
   * is invisible otherwise — the version simply never changes, which reads as "the
   * button did nothing".
   *
   * ⚠ THAT ARGUMENT EXPIRES ONCE THE JOB IS OVER, and for a while this did not notice.
   * `lastUpdate` is one column overwritten only by the next update, so whatever it holds
   * stays on screen forever: a host read "update failed · NOT_NEWER" indefinitely while
   * running the newest published agent, and another announced "updated" long after the
   * version number beside it had already said so. `updateNotice` is where that judgement
   * lives — running, or ended badly and not yet overtaken — so this screen and the host
   * detail page cannot answer it differently.
   */
  import { Badge } from "$lib/components/ui/badge";
  import { getI18n } from "$lib/i18n";
  import { updateInFlight, updateNotice, updateProgressPct } from "$lib/dashboard/agent-update";
  import type { HostView } from "$lib/dashboard/types";

  let { host }: { host: HostView } = $props();

  const i18n = getI18n();
  const state = $derived(host.agentVersionState);
  const inFlight = $derived(updateInFlight(host.lastUpdate));
  const stateLabel = $derived(i18n.t.dash.agent.state[state]);
  const outcome = $derived(updateNotice(host));
  const pct = $derived(updateProgressPct(outcome));
  /**
   * ⚠ THE VERDICT BADGE STANDS DOWN WHILE A JOB IS RUNNING. `agent.state.outdated` is not news
   * about a host somebody is in the middle of updating — it is the reason they
   * pressed the button — and it competed for room with the two things that ARE
   * news: where this host is going, and how far it got.
   */
  const showBadge = $derived(!inFlight);
</script>

<!--
  ⚠ ONE ROW, NOT A COLUMN. This was `flex-col` with three children and the first
  one wrapping, so it rendered as up to FOUR stacked lines — unconditionally, even
  where there was room to spare. Both callers are horizontal: `/hosts` gives it one
  cell of eight (every stacked line makes that row taller than its neighbours), and
  the host detail page drops it into a `·`-separated strip of one-line facts, where
  a three-line block pushes the whole header out of alignment.

  `flex-wrap` stays: a genuinely narrow viewport SHOULD fold this. What it must not
  do is fold when nothing is forcing it to.
-->
<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
  <span class="tabular-nums">{host.agentVersion ?? "\u2014"}</span>
  {#if showBadge}
    {#if state === "incompatible"}
      <Badge variant="destructive" data-testid={`agent-state-${host.id}`}>{stateLabel}</Badge>
    {:else if state === "outdated"}
      <Badge variant="outline" class="text-amber-600 dark:text-amber-400" data-testid={`agent-state-${host.id}`}>
        {stateLabel}
      </Badge>
    {:else if state === "current"}
      <Badge variant="outline" class="text-green-600 dark:text-green-400" data-testid={`agent-state-${host.id}`}>
        {stateLabel}
      </Badge>
    {:else}
      <!-- `ahead` and `unknown`: both are "we cannot call this host behind". -->
      <Badge variant="secondary" data-testid={`agent-state-${host.id}`}>{stateLabel}</Badge>
    {/if}
  {/if}
  <!-- Where it is headed. During a job this replaces the badge rather than sitting
       under it, because "0.1.3 → 0.1.6" answers the same question better. -->
  {#if inFlight && outcome?.targetVersion}
    <span class="text-muted-foreground text-xs tabular-nums" data-testid={`agent-target-${host.id}`}>
      &rarr; {outcome.targetVersion}
    </span>
  {:else if state === "outdated" && host.latestAgentVersion}
    <span class="text-muted-foreground text-xs tabular-nums">&rarr; {host.latestAgentVersion}</span>
  {/if}
  {#if outcome}
    <span
      class="text-xs {outcome.phase === 'failed' || outcome.phase === 'rolledBack'
        ? 'text-destructive'
        : 'text-muted-foreground'}"
      title={outcome.phase === "restarting" ? i18n.t.dash.agent.probation : undefined}
      data-testid={`agent-update-status-${host.id}`}
    >
      <!-- ⚠ THE SEPARATORS ARE WRITTEN INLINE ON PURPOSE. Svelte strips the
           newline+indent that used to sit inside these blocks, which rendered as
           `agent.phase.restarting` run into the percentage — the space landed on the wrong side of the dot. -->
      {i18n.t.dash.agent.phase[outcome.phase]}{#if pct !== null}&nbsp;&middot;&nbsp;{pct}%{/if}{#if outcome.code}&nbsp;&middot;&nbsp;{outcome.code}{/if}
    </span>
  {/if}
</div>
