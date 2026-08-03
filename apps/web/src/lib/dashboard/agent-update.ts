/**
 * The decisions behind the agent-version badge and the update button.
 *
 * Pure functions over a `HostView` (plus the grid the operator is looking at), so
 * "which states offer an update", "how many panes does this cost" and "why did a
 * rollout stop" can be asserted without a browser — and so the two screens that
 * show them (`/hosts`, `/hosts/[id]`) cannot drift into two different answers.
 *
 * NOTHING HERE FORMATS PROSE. Every string a person reads comes from the i18n
 * catalogue; what these functions return is counts, codes and verdicts.
 */
import type { GridCell } from "@pdmux/core";
import { type AgentVersionState, type UpdateStatus, compareVersionStrings } from "@pdmux/protocol";
import type { FleetUpdateFailure, HostView } from "./types";

/** Phases in which the agent is still working on a job we started. */
const IN_FLIGHT: ReadonlySet<UpdateStatus["phase"]> = new Set([
  "accepted",
  "downloading",
  "verifying",
  "swapping",
  "restarting",
]);

/** True while an update is running — the button must not offer a second one. */
export function updateInFlight(status: UpdateStatus | null): boolean {
  return status !== null && IN_FLIGHT.has(status.phase);
}

/** The two phases that end a job badly, and are the only ones painted as an alarm. */
const TERMINAL_FAILURE: ReadonlySet<UpdateStatus["phase"]> = new Set(["failed", "rolledBack"]);

/**
 * Has the host already moved past the failure it is still reporting?
 *
 * THE BUG THIS EXISTS FOR: a host sat on the fleet screen reading
 * "update failed · NOT_NEWER" while running the newest published agent. Every part of
 * that was working as designed and the sentence was still false. `lastUpdate` is ONE
 * COLUMN holding the last thing an agent said about an update, and the only thing
 * that ever overwrites it is the next update — so a host that is `current` gets no
 * update button (`offersUpdate`), nothing overwrites the row, and the alarm is
 * permanent. There was no way to clear it from the dashboard at all.
 *
 * NOT_NEWER makes it sharpest, because that refusal is itself proof the host was
 * ALREADY ahead of what was offered: target 0.1.0, running 0.1.1. But the rule is not
 * about one code. A failure is spent once the host reports a version that reaches or
 * passes the version that failed, however it got there — a later successful update, a
 * hand-installed binary, a re-image.
 *
 * ⚠ SPENT IS NOT THE SAME AS UNIMPORTANT, and the default leans the other way. A host
 * still BELOW the target keeps its failure: that line is the only place a rollout that
 * silently did nothing becomes visible, which is the reason it was put on the screen.
 * So this answers "yes" only when it can prove the host has caught up — a missing
 * target version, or a pair semver cannot compare (a dev build), keeps the line.
 */
export function updateSuperseded(host: HostView): boolean {
  const status = host.lastUpdate;
  if (status === null || !TERMINAL_FAILURE.has(status.phase)) return false;
  if (!status.targetVersion || !host.agentVersion) return false;
  // `null` from an uncomparable pair falls through to `false`: unreadable is not proof.
  return (compareVersionStrings(host.agentVersion, status.targetVersion) ?? -1) >= 0;
}

/**
 * The last-update line worth putting on screen — `null` when there is none.
 *
 * The line exists because a rollout that silently did nothing is invisible otherwise:
 * the version never changes, which reads as "the button did nothing". Everything it
 * shows has to earn its place against that purpose, and only two kinds of job do.
 *
 *   RUNNING — the phase and the percentage are the only report there is.
 *   ENDED BADLY, and not yet overtaken — the reason the line was added.
 *
 * ⚠ A JOB THAT ENDED WELL IS NOT NEWS, and saying so anyway was reported as clutter.
 * `done` renders as "updated", which the two things beside it have already said better:
 * the version number IS the new version, and the badge next to it reads `current`. It
 * is also permanent — `lastUpdate` is one column overwritten only by the next update —
 * so a host that updated days ago still announces it, which is the same complaint as
 * the stale `NOT_NEWER` (`updateSuperseded`) wearing a friendlier word.
 */
export function updateNotice(host: HostView): UpdateStatus | null {
  const status = host.lastUpdate;
  if (status === null) return null;
  if (updateInFlight(status)) return status;
  if (status.phase === "done") return null;
  return updateSuperseded(host) ? null : status;
}

/**
 * The percentage worth showing, or null.
 *
 * ⚠ `progressPct` IS DOWNLOAD PROGRESS, NOT JOB PROGRESS, and showing it past the
 * download turned it into a lie. The agent sets it to 100 when it starts
 * `verifying` and leaves it there through `swapping` and `restarting` — so a host
 * mid-restart showed `agent.phase.restarting` beside "100%", which every reader
 * takes as "finished".
 * It is not finished: `restarting` is the probation window, the one phase that can
 * still roll the host back to the version it came from.
 *
 * Measured in production during the 0.1.3 → 0.1.6 rollout: phase `restarting`,
 * progressPct 100, and the agent's own message said "probation ends in 300s".
 *
 * So the number is shown only where it still counts something, and the phase word
 * carries the rest. Nothing else changes — the value is left exactly as the agent
 * reported it, because a percentage this app recomputed would be a second opinion
 * about a thing only the agent can see.
 */
export function updateProgressPct(status: UpdateStatus | null): number | null {
  if (status === null || status.phase !== "downloading") return null;
  return status.progressPct;
}

/**
 * Which version states get an "Update agent" action.
 *
 * `ahead` NEVER does. A host running a build newer than anything published is a
 * developer on a local build, and "update" would silently downgrade them — the one
 * outcome nobody clicking that button wants.
 *
 * `unknown` DOES, even though we cannot say the host is behind: an unreadable
 * version (or a platform with nothing published) is precisely the state you cannot
 * leave any other way, and refusing would strand it.
 *
 * `current` does not: there is nothing newer to go to, and a button that reinstalls
 * the same bytes is a restart wearing an update's clothes. (Forcing a reinstall
 * stays available through the API's `force` flag; it is not a fleet-screen verb.)
 */
export function offersUpdate(state: AgentVersionState): boolean {
  return state === "outdated" || state === "unknown" || state === "incompatible";
}

/** What the sidebar card shows, or nothing at all. */
export type CardUpdate =
  | { kind: "offer" | "urgent"; version: string }
  | { kind: "busy"; phase: UpdateStatus["phase"]; version: string | null };

/**
 * Whether a host card says anything about its agent, and what.
 *
 * This file exists so "the two screens that show them cannot drift into two
 * different answers"; the sidebar is the third, so the rule lives here rather than
 * in a component.
 *
 * ⚠ DO NOT REACH FOR `updateSkip()`. That is the BATCH policy and it excludes every
 * `unknown` host — "a batch declines to guess. Its own row menu still offers it".
 * Using it here would strand exactly the hosts that have no other way out, which is
 * the opposite of what `offersUpdate` is documented to do.
 *
 * ⚠ THE ORDER OF THE RULES IS THE DESIGN, and rule 2 before rule 3 is the one worth
 * defending: `restarting` IS the probation window — the agent is being replaced and
 * its heartbeat can lapse. Checking `online` first would make the mark blink out at
 * the exact moment the operator is watching it work.
 */
export function cardUpdate(host: HostView): CardUpdate | null {
  // Nobody is asking this machine anything; the card's own mark already says so.
  if (!host.enabled) return null;

  if (updateInFlight(host.lastUpdate)) {
    return { kind: "busy", phase: host.lastUpdate?.phase ?? "accepted", version: host.lastUpdate?.targetVersion ?? null };
  }

  // The card already reads "stopped". An update offer beside that contradicts it.
  if (!host.online) return null;

  if (!offersUpdate(host.agentVersionState)) return null;

  // ⚠ THIS IS WHAT SPLITS THE TWO MEANINGS OF `unknown` (an unreadable version, and
  // nothing published for this platform — `semver.ts` conflates them). With no
  // target there is nothing to name, so the popover's one job would render "→ —"
  // and the button would earn AGENT_RELEASE_UNAVAILABLE. In a column whose whole
  // budget is one short line, a mark that cannot say where it leads is noise.
  if (!host.latestAgentVersion) return null;

  return {
    kind: host.agentVersionState === "incompatible" ? "urgent" : "offer",
    version: host.latestAgentVersion,
  };
}

/**
 * Which states may be swept up in a BATCH.
 *
 * `unknown` is excluded on purpose. One at a time it is the way out; multiplied by
 * a checkbox it is "send a build to every host we could not read", which is how a
 * rollout reaches machines nobody meant to touch. It stays reachable from its own
 * row menu.
 */
export function bulkSelectable(state: AgentVersionState): boolean {
  return state === "outdated" || state === "incompatible";
}

/**
 * Why an update would pass this host over — `null` when it would not.
 *
 * ⚠ THIS USED TO BE THE CHECKBOX'S `disabled`, AND THAT WAS THE WRONG PLACE FOR IT.
 * The tick-box was gated on "could this host be updated", which made a general
 * selection mechanism into an update-only one: with a fleet that is entirely up to
 * date every box on the screen is dead, and a column of permanently disabled
 * controls under a blank header reads as a broken table. It was reported as exactly
 * that.
 *
 * So selection is now free and the question moves HERE, to the moment an action is
 * chosen. Nothing is lost by that — the rule that mattered was never "you may not
 * tick this", it was "a batch must not quietly reach machines nobody meant to
 * touch", and a dialog that lists what it is skipping and why enforces it better
 * than a disabled control that explains nothing.
 *
 * ORDER IS DELIBERATE: the reasons are not equally interesting. Reachability comes
 * first because nothing can happen at all, then a job already running, and only then
 * the version verdict — telling someone their host is "already current" when it is
 * actually switched off sends them looking in the wrong place.
 */
export type UpdateSkip = "disabled" | "offline" | "inFlight" | "unknown" | "ahead" | "current" | "noBuild";

export function updateSkip(host: HostView): UpdateSkip | null {
  if (!host.enabled) return "disabled";
  if (!host.online) return "offline";
  if (updateInFlight(host.lastUpdate)) return "inFlight";
  // `unknown` is the one that is a POLICY rather than an obstacle: the version is
  // unreadable, so a batch declines to guess. Its own row menu still offers it.
  if (host.agentVersionState === "unknown") return "unknown";
  if (host.agentVersionState === "ahead") return "ahead";
  if (host.agentVersionState === "current") return "current";
  // Reachable, behind, and still nothing to send: no published build covers its
  // platform. Distinct from `current`, and the operator can act on it.
  if (!host.latestAgentVersion) return "noBuild";
  return null;
}

/** Hosts a batch would actually move. One definition, so nothing can disagree with the dialog. */
export function bulkEligible(host: HostView): boolean {
  return updateSkip(host) === null;
}

export interface BulkUpdatePlan {
  /** Sent. */
  updatable: HostView[];
  /** Not sent, each with the reason the dialog shows. */
  skipped: { host: HostView; reason: UpdateSkip }[];
  /** The one version the updatable hosts agree on. */
  version: string | null;
  /** Every distinct version across them when they do not agree. */
  conflict: string[];
}

/**
 * Split a selection into what an update would move and what it would pass over.
 *
 * THE DIALOG'S WHOLE JOB IS THIS SPLIT. An operator who ticks eleven rows and gets
 * "3 hosts updated" has been told the outcome of something they did not agree to;
 * the same person shown "3 will update, 8 skipped — 6 already current, 2 offline"
 * before pressing anything is making the decision themselves. It is also the only
 * honest way to let every row be tickable, which is the point.
 */
export function planBulkUpdate(selected: readonly HostView[]): BulkUpdatePlan {
  const updatable: HostView[] = [];
  const skipped: { host: HostView; reason: UpdateSkip }[] = [];
  for (const host of selected) {
    const reason = updateSkip(host);
    if (reason === null) updatable.push(host);
    else skipped.push({ host, reason });
  }
  return { updatable, skipped, ...bulkTarget(updatable) };
}

/**
 * Would the server refuse this batch for want of a canary?
 *
 * `POST /fleet/agent/update` answers `NO_CANARY` (409) when no host in the fleet is
 * already running the version being rolled out: "update a single host first, then roll
 * it out to the rest". It is a good rule — it stops a build nobody has run reaching
 * every machine at once — and it fires on exactly the case an operator meets most, the
 * first press after a new release.
 *
 * ⚠ IT WAS INVISIBLE UNTIL THE CLICK. The dialog listed the hosts, said which version,
 * took the confirmation, and then a toast reported the refusal — measured on a real
 * rollout, where selecting both hosts and pressing update simply did nothing anybody
 * could see. Knowing beforehand costs one pass over the fleet.
 *
 * ⚠ THE FLEET, NOT THE SELECTION, and not the filtered rows either. The canary can be
 * any host in the organisation, including one the operator did not tick and one a
 * search has hidden — counting only what is on screen would invent a refusal the
 * server would not make.
 */
export function canaryNeeded(fleet: readonly HostView[], version: string | null): boolean {
  if (!version) return false;
  return !fleet.some((host) => host.agentVersion === version);
}

export interface SelectAllState {
  checked: boolean;
  indeterminate: boolean;
}

/**
 * What the select-all box shows.
 *
 * ⚠ AN EMPTY TABLE IS NOT "ALL SELECTED", though `every()` on an empty array says it
 * is — that is the classic way this control ends up ticked over a table with nothing
 * in it, offering to act on nothing. The partial state is its own answer rather than
 * a rounding of the other two: without it, ticking one row of ten leaves the header
 * box empty and the operator cannot tell a selection exists at all.
 */
export function selectAllState(rows: readonly HostView[], selectedIds: readonly string[]): SelectAllState {
  if (rows.length === 0) return { checked: false, indeterminate: false };
  const picked = rows.filter((host) => selectedIds.includes(host.id)).length;
  return { checked: picked === rows.length, indeterminate: picked > 0 && picked < rows.length };
}

export interface BulkTarget {
  /** The one version every selected host would be moved to, when they agree. */
  version: string | null;
  /** Every distinct published version across the selection, sorted, when they do not. */
  conflict: string[];
}

/**
 * The single version a batch can ask for.
 *
 * `POST /fleet/agent/update` takes ONE version for the whole batch while
 * `latestAgentVersion` is resolved per (os, arch). Usually they agree — one release,
 * several binaries — but a fleet mid-publish can hold two, and sending the newer
 * one would ask half the hosts for a build that does not exist for them. So a
 * disagreement is reported rather than resolved by picking a winner.
 */
export function bulkTarget(hosts: readonly HostView[]): BulkTarget {
  const versions = [...new Set(hosts.map((host) => host.latestAgentVersion).filter((v): v is string => !!v))];
  versions.sort();
  if (versions.length === 1) return { version: versions[0] ?? null, conflict: [] };
  return { version: null, conflict: versions };
}

/** A terminal pane the operator has open, as the grid stores it. */
export interface PaneSlot {
  hostId: string;
  kind: "shell" | "session";
}

/**
 * The grid's three kinds collapse to the two that a RESTART distinguishes.
 *
 * `attach` and `new` both end up on a multiplexer session, which outlives the agent
 * process; only `shell` is a bare login shell that dies with it. Doing this mapping
 * here means the confirmation and the grid cannot disagree about which is which.
 */
export function paneSlots(cells: readonly GridCell[]): PaneSlot[] {
  return cells
    .filter((cell): cell is NonNullable<GridCell> => cell !== null)
    .map((cell) => ({ hostId: cell.hostId, kind: cell.kind === "shell" ? "shell" : "session" }));
}

export interface PanePlan {
  /** Killed by the restart, along with whatever they were running. */
  shellPanes: number;
  /** Survive it: the multiplexer keeps the session and the pane re-attaches. */
  sessionPanes: number;
}

/**
 * What an update costs in panes, for the sentence the confirmation puts in front
 * of the operator.
 *
 * TWO SOURCES, AND THE LARGER WINS. The grid knows what THIS browser has open on
 * the host right now; `lastUpdate` carries what the AGENT counted when it accepted
 * a job, which covers panes this browser cannot see (another operator, another
 * tab). Neither is complete on its own, and undercounting is the dangerous
 * direction — a dialog that promises nothing will be lost and then loses something
 * is the failure this whole screen exists to prevent, while an over-count only
 * makes someone read the sentence twice.
 */
export function panePlan(host: HostView, slots: readonly PaneSlot[] = []): PanePlan {
  const mine = slots.filter((slot) => slot.hostId === host.id);
  const reported = host.lastUpdate;
  return {
    shellPanes: Math.max(
      mine.filter((slot) => slot.kind === "shell").length,
      reported?.shellPanes ?? 0,
    ),
    sessionPanes: Math.max(
      mine.filter((slot) => slot.kind === "session").length,
      reported?.sessionPanes ?? 0,
    ),
  };
}

export interface FailureGroup {
  code: string;
  count: number;
}

/**
 * Failures grouped by CODE, most frequent first.
 *
 * The grouping is the finding, not a tidier list: the same code across several
 * hosts says the release is bad, and one code per host says the hosts are. A flat
 * list of "host-a failed, host-b failed" hides which of the two you are looking at.
 */
export function groupFailures(failed: readonly FleetUpdateFailure[]): FailureGroup[] {
  const counts = new Map<string, number>();
  for (const failure of failed) counts.set(failure.code, (counts.get(failure.code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** `VERIFY_FAILED ×2, SHA_MISMATCH ×1` — codes are identifiers, so they are not translated. */
export function failureCodes(failed: readonly FleetUpdateFailure[]): string {
  return groupFailures(failed)
    .map((group) => `${group.code} ×${group.count}`)
    .join(", ");
}
