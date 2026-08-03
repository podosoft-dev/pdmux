/**
 * The verdicts behind the agent-version badge, the update button and a batch.
 *
 * These are the decisions a screenshot cannot check: which states offer an update,
 * which may be swept up by a checkbox, what an update costs in panes, and why a
 * rollout stopped. Locking them here keeps `/hosts` and `/hosts/[id]` from drifting
 * into two different answers.
 */
import { describe, expect, it } from "vitest";
import type { GridCell } from "@pdmux/core";
import type { UpdateStatus } from "@pdmux/protocol";
import {
  bulkEligible,
  cardUpdate,
  bulkSelectable,
  bulkTarget,
  canaryNeeded,
  failureCodes,
  groupFailures,
  offersUpdate,
  paneSlots,
  panePlan,
  planBulkUpdate,
  updateProgressPct,
  selectAllState,
  updateInFlight,
  updateNotice,
  updateSkip,
  updateSuperseded,
} from "$lib/dashboard/agent-update";
import type { HostView } from "$lib/dashboard/types";

function host(overrides: Partial<HostView> = {}): HostView {
  return {
    id: "h1",
    label: "alpha",
    address: null,
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "0.1.0",
    latestAgentVersion: "0.2.0",
    agentVersionState: "outdated",
    lastUpdate: null,
    os: "linux",
    arch: "amd64",
    capabilities: [],
    lastSeenAt: null,
    online: true,
    connected: true,
    resource: null,
    sessions: [],
    usage: [],
    diagnostics: [],
    services: [],
    gitRootCount: 0,
    listeners: [],
    ...overrides,
  };
}

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    commandId: "8a2f6f36-2b19-4a2f-9d0b-2a4e5f6c7d8e",
    phase: "done",
    progressPct: null,
    currentVersion: "0.2.0",
    targetVersion: "0.2.0",
    code: null,
    message: "",
    shellPanes: 0,
    sessionPanes: 0,
    ...overrides,
  };
}

describe("agent version affordances", () => {
  it("never offers an update to a host that is ahead", () => {
    // A newer-than-published build is a developer on a local one. "Update" there is
    // a silent downgrade, which is the one outcome nobody clicking it wants.
    expect(offersUpdate("ahead")).toBe(false);
    expect(offersUpdate("current")).toBe(false);
  });

  it("offers an update for outdated, unknown and incompatible", () => {
    // `unknown` included on purpose: an unreadable version is the state you cannot
    // leave any other way.
    expect(offersUpdate("outdated")).toBe(true);
    expect(offersUpdate("unknown")).toBe(true);
    expect(offersUpdate("incompatible")).toBe(true);
  });

  it("keeps unknown out of a batch even though it offers a single update", () => {
    expect(bulkSelectable("unknown")).toBe(false);
    expect(bulkSelectable("outdated")).toBe(true);
    expect(bulkSelectable("incompatible")).toBe(true);
  });

  it("does not let a disabled, offline or already-updating host be updated in a batch", () => {
    expect(bulkEligible(host())).toBe(true);
    expect(bulkEligible(host({ enabled: false }))).toBe(false);
    expect(bulkEligible(host({ online: false }))).toBe(false);
    expect(bulkEligible(host({ lastUpdate: status({ phase: "downloading" }) }))).toBe(false);
    expect(bulkEligible(host({ lastUpdate: status({ phase: "done" }) }))).toBe(true);
  });

  it("reads only the working phases as in flight", () => {
    expect(updateInFlight(null)).toBe(false);
    expect(updateInFlight(status({ phase: "accepted" }))).toBe(true);
    expect(updateInFlight(status({ phase: "restarting" }))).toBe(true);
    expect(updateInFlight(status({ phase: "failed" }))).toBe(false);
    expect(updateInFlight(status({ phase: "rolledBack" }))).toBe(false);
  });
});

describe("batch target version", () => {
  it("takes the one version the selection agrees on", () => {
    expect(bulkTarget([host(), host({ id: "h2" })])).toEqual({ version: "0.2.0", conflict: [] });
  });

  it("reports a disagreement rather than picking a winner", () => {
    // One version travels for the whole batch while the newest build is resolved
    // per (os, arch); choosing one would ask half the hosts for a build that does
    // not exist for them.
    const mixed = bulkTarget([host(), host({ id: "h2", latestAgentVersion: "0.3.0" })]);
    expect(mixed.version).toBeNull();
    expect(mixed.conflict).toEqual(["0.2.0", "0.3.0"]);
  });
});

describe("pane plan", () => {
  const cells: GridCell[] = [
    { id: "s1", hostId: "h1", kind: "shell", session: null },
    { id: "s2", hostId: "h1", kind: "attach", session: "work" },
    { id: "s3", hostId: "h1", kind: "new", session: "build" },
    { id: "s4", hostId: "other", kind: "shell", session: null },
    null,
  ];

  it("collapses the grid's three kinds into the two a restart distinguishes", () => {
    expect(paneSlots(cells)).toEqual([
      { hostId: "h1", kind: "shell" },
      { hostId: "h1", kind: "session" },
      { hostId: "h1", kind: "session" },
      { hostId: "other", kind: "shell" },
    ]);
  });

  it("counts only the panes on this host", () => {
    expect(panePlan(host(), paneSlots(cells))).toEqual({ shellPanes: 1, sessionPanes: 2 });
  });

  it("takes the larger of the grid and what the agent reported", () => {
    // Undercounting is the dangerous direction: a dialog that promises nothing will
    // be lost and then loses something is the failure this screen exists to stop.
    const reported = host({ lastUpdate: status({ shellPanes: 4, sessionPanes: 1 }) });
    expect(panePlan(reported, paneSlots(cells))).toEqual({ shellPanes: 4, sessionPanes: 2 });
  });

  it("is zero for a host with nothing open and nothing reported", () => {
    expect(panePlan(host({ id: "quiet" }), paneSlots(cells))).toEqual({ shellPanes: 0, sessionPanes: 0 });
  });
});

describe("fleet failures", () => {
  const failed = [
    { hostId: "a", code: "VERIFY_FAILED", message: "" },
    { hostId: "b", code: "SHA_MISMATCH", message: "" },
    { hostId: "c", code: "VERIFY_FAILED", message: "" },
  ];

  it("groups by code, most frequent first", () => {
    // Identical codes across hosts is the signal that the RELEASE is bad; one code
    // per host says the hosts are. A flat list hides which of the two you are in.
    expect(groupFailures(failed)).toEqual([
      { code: "VERIFY_FAILED", count: 2 },
      { code: "SHA_MISMATCH", count: 1 },
    ]);
  });

  it("renders the codes as stable identifiers, not prose", () => {
    expect(failureCodes(failed)).toBe("VERIFY_FAILED ×2, SHA_MISMATCH ×1");
  });
});

describe("[TC-PDWEB-014] the last-update line only reports what the version cannot", () => {
  /**
   * REPORTED: the Agent column carried "updated" — the `done` phase — as clutter. It is:
   * the version number beside it IS the new version and the badge next to that reads
   * `current`, so the line repeats them in worse words. It is also permanent, because
   * `lastUpdate` is one column overwritten only by the next update, so a host that
   * updated days ago goes on announcing it.
   *
   * The line was added because a rollout that silently did nothing is invisible
   * otherwise — the version simply never changes. Only two kinds of job serve that:
   * one still running, and one that ended badly and has not been overtaken.
   */
  it("drops a job that finished successfully", () => {
    const done = host({
      agentVersion: "1.5.0",
      agentVersionState: "current",
      lastUpdate: status({ phase: "done", currentVersion: "1.5.0", targetVersion: "1.5.0" }),
    });
    expect(updateNotice(done)).toBeNull();
  });

  it("keeps a job that is still running, because nothing else reports it", () => {
    for (const phase of ["accepted", "downloading", "verifying", "swapping", "restarting"] as const) {
      const running = host({ lastUpdate: status({ phase, progressPct: 40 }) });
      expect(updateNotice(running)?.phase, phase).toBe(phase);
    }
  });

  it("keeps a failure the host has not caught up with, and drops one it has", () => {
    // The two halves of the rule that was already there, now reached through one door
    // so the fleet screen and the host page cannot answer them differently.
    const stuck = host({
      agentVersion: "1.4.0",
      lastUpdate: status({ phase: "failed", code: "VERIFY_FAILED", targetVersion: "1.5.0" }),
    });
    expect(updateNotice(stuck)?.code).toBe("VERIFY_FAILED");
    const caughtUp = host({
      agentVersion: "1.5.0",
      lastUpdate: status({ phase: "failed", code: "NOT_NEWER", targetVersion: "1.4.0" }),
    });
    expect(updateNotice(caughtUp)).toBeNull();
  });

  it("says nothing about a host that has never been updated", () => {
    expect(updateNotice(host({ lastUpdate: null }))).toBeNull();
  });

  it("shows an in-flight job even when it targets a version the host already has", () => {
    // ⚠ ORDER MATTERS. A forced reinstall is `targetVersion === agentVersion`, which
    // `updateSuperseded` would call spent — mid-download, with a progress bar the
    // operator is watching. Running is checked first for exactly this.
    const reinstalling = host({
      agentVersion: "1.5.0",
      lastUpdate: status({ phase: "downloading", progressPct: 20, targetVersion: "1.5.0" }),
    });
    expect(updateNotice(reinstalling)?.progressPct).toBe(20);
  });
});

describe("[TC-PDWEB-011] selection is free, and each action says what it can do with it", () => {
  /**
   * REPORTED: the fleet table's checkboxes did nothing. They were gated on "could this
   * host be updated", so with a fleet that is entirely up to date — the ordinary state
   * — every box on the screen was disabled, under a blank column header, with nothing
   * saying why. A column of controls that never click reads as a broken table.
   *
   * ⚠ THE RULE THEY ENFORCED IS NOT DROPPED, IT MOVED. A batch must not quietly reach
   * machines nobody meant to touch, and `unknown` — a version we could not read — is
   * the case that mattered. It is now refused OUT LOUD in the confirmation instead of
   * by a control that will not move and does not explain itself.
   */
  it("names why a host would be passed over, in the order that helps", () => {
    expect(updateSkip(host())).toBeNull();
    // Reachability first: telling somebody their host is "already current" when it is
    // switched off sends them looking in the wrong place.
    expect(updateSkip(host({ enabled: false, online: false, agentVersionState: "current" }))).toBe("disabled");
    expect(updateSkip(host({ online: false, agentVersionState: "current" }))).toBe("offline");
    expect(updateSkip(host({ lastUpdate: status({ phase: "downloading" }) }))).toBe("inFlight");
    expect(updateSkip(host({ agentVersionState: "unknown" }))).toBe("unknown");
    expect(updateSkip(host({ agentVersionState: "ahead" }))).toBe("ahead");
    expect(updateSkip(host({ agentVersionState: "current" }))).toBe("current");
    // Reachable, behind, and still nothing to send — distinct from `current`, and the
    // operator can act on it.
    expect(updateSkip(host({ latestAgentVersion: null }))).toBe("noBuild");
  });

  it("splits a mixed selection into what moves and what does not", () => {
    const plan = planBulkUpdate([
      host({ id: "a", label: "a" }),
      host({ id: "b", label: "b", agentVersionState: "incompatible" }),
      host({ id: "c", label: "c", agentVersionState: "current" }),
      host({ id: "d", label: "d", agentVersionState: "unknown" }),
      host({ id: "e", label: "e", online: false }),
    ]);
    expect(plan.updatable.map((h) => h.id)).toEqual(["a", "b"]);
    expect(plan.skipped.map((s) => [s.host.id, s.reason])).toEqual([
      ["c", "current"],
      ["d", "unknown"],
      ["e", "offline"],
    ]);
    // The version the batch would send, resolved from the hosts it will actually move.
    expect(plan.version).toBe("0.2.0");
  });

  it("still refuses to guess at a host whose version it cannot read", () => {
    // The whole selection is unreadable: everything is tickable, nothing is sent, and
    // the dialog has a reason to show rather than a disabled button.
    const plan = planBulkUpdate([host({ agentVersionState: "unknown" }), host({ id: "h2", agentVersionState: "unknown" })]);
    expect(plan.updatable).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.version).toBeNull();
  });

  it("reports a version disagreement instead of picking a winner", () => {
    // One version travels for the whole batch while the newest build is resolved per
    // (os, arch). Choosing one would ask half of them for a build that does not exist.
    const plan = planBulkUpdate([host(), host({ id: "h2", latestAgentVersion: "0.3.0" })]);
    expect(plan.version).toBeNull();
    expect(plan.conflict).toEqual(["0.2.0", "0.3.0"]);
    // ...and the conflict is read off the UPDATABLE hosts only, so a skipped host's
    // version cannot manufacture a disagreement that would block the others.
    const withSkipped = planBulkUpdate([host(), host({ id: "h2", latestAgentVersion: "0.3.0", online: false })]);
    expect(withSkipped.version).toBe("0.2.0");
  });

  it("empty in, empty out", () => {
    expect(planBulkUpdate([])).toEqual({ updatable: [], skipped: [], version: null, conflict: [] });
  });
});

describe("[TC-PDWEB-015] a batch says up front that it needs a canary", () => {
  /**
   * REPORTED: pressing update on a freshly published version looked like it did
   * nothing. `POST /fleet/agent/update` answers NO_CANARY (409) when no host is
   * already running the target — "update a single host first, then roll it out" — and
   * the operator only learned that from a toast AFTER confirming a dialog that had
   * listed every host and taken the confirmation. Measured on a real rollout.
   *
   * The rule itself is good: it stops a build nobody has run reaching every machine at
   * once. Only its timing was wrong.
   */
  it("is needed when nothing in the fleet runs the target yet", () => {
    const fleet = [host({ id: "a", agentVersion: "1.4.0" }), host({ id: "b", agentVersion: "1.4.0" })];
    expect(canaryNeeded(fleet, "1.5.0")).toBe(true);
  });

  it("is satisfied by ANY host on that version, ticked or not", () => {
    // ⚠ The fleet, not the selection. The server counts across the organisation, so a
    // canary the operator did not select still counts — treating it otherwise would
    // invent a refusal the server would never make.
    const fleet = [host({ id: "a", agentVersion: "1.5.0" }), host({ id: "b", agentVersion: "1.4.0" })];
    expect(canaryNeeded(fleet, "1.5.0")).toBe(false);
  });

  it("says nothing when there is no target to check", () => {
    // A selection whose versions disagree has no single target; the dialog is already
    // reporting that, and a second complaint about a version nobody named helps nobody.
    expect(canaryNeeded([host()], null)).toBe(false);
  });

  it("counts an empty fleet as needing one, not as satisfying it", () => {
    // `some()` on an empty array is false, which is the right answer here and the
    // opposite of the trap in `selectAllState` — worth pinning so a later tidy-up of
    // one does not "fix" the other.
    expect(canaryNeeded([], "1.5.0")).toBe(true);
  });
});

describe("[TC-PDWEB-012] select-all reflects the rows in front of the operator", () => {
  const rows = [host({ id: "a" }), host({ id: "b" }), host({ id: "c" })];

  it("is unchecked, checked, or partial — and partial is its own answer", () => {
    expect(selectAllState(rows, [])).toEqual({ checked: false, indeterminate: false });
    // Without the partial state, ticking one row of three leaves the box empty and
    // nothing on screen says a selection exists.
    expect(selectAllState(rows, ["a"])).toEqual({ checked: false, indeterminate: true });
    expect(selectAllState(rows, ["a", "b"])).toEqual({ checked: false, indeterminate: true });
    expect(selectAllState(rows, ["a", "b", "c"])).toEqual({ checked: true, indeterminate: false });
  });

  it("an empty table is not 'all selected'", () => {
    // ⚠ `every()` on an empty array says true, which is how this control ends up
    // ticked over a table with nothing in it, offering to act on nothing.
    expect(selectAllState([], [])).toEqual({ checked: false, indeterminate: false });
    expect(selectAllState([], ["ghost"])).toEqual({ checked: false, indeterminate: false });
  });

  it("ignores a selected id that is no longer on the table", () => {
    // Search narrows `rows`; an id left over from a wider view must not make the box
    // claim a full selection of a list that no longer contains it.
    expect(selectAllState(rows, ["a", "b", "c", "filtered-out"])).toEqual({ checked: true, indeterminate: false });
    expect(selectAllState(rows, ["filtered-out"])).toEqual({ checked: false, indeterminate: false });
  });
});

describe("[TC-PDWEB-010] a failure the host has moved past stops being reported", () => {
  /**
   * REPORTED: a host showed "update failed · NOT_NEWER" on the fleet screen while
   * running the newest published agent. Nothing had malfunctioned — the agent refused a
   * DOWNGRADE (target 0.1.0, running 0.1.1) and was right to. The defect is that the
   * refusal never left the screen: `lastUpdate` is one column overwritten only by the
   * next update, and a host that is `current` is offered no update, so nothing could
   * ever overwrite it. A permanent alarm on a host with nothing wrong with it.
   */
  it("drops a refusal the host is already ahead of", () => {
    // The exact live row. NOT_NEWER is self-evidently spent: the refusal happened
    // BECAUSE the host was already past the version being offered.
    const caughtUp = host({
      agentVersion: "0.1.1",
      latestAgentVersion: "0.1.1",
      agentVersionState: "current",
      lastUpdate: status({
        phase: "failed",
        code: "NOT_NEWER",
        currentVersion: "0.1.1",
        targetVersion: "0.1.0",
        message: "0.1.0 is not newer than the running 0.1.1 (use force for a deliberate downgrade)",
      }),
    });
    expect(updateSuperseded(caughtUp)).toBe(true);
  });

  it("drops it once the host reaches the target, whatever the code was", () => {
    // Not a rule about NOT_NEWER. A verify failure that a later attempt — or a hand
    // installed binary — got past is equally spent, and equal at the boundary too.
    for (const code of ["VERIFY_FAILED", "DOWNLOAD_FAILED", "SWAP_FAILED"]) {
      const caught = host({
        agentVersion: "0.2.0",
        agentVersionState: "current",
        lastUpdate: status({ phase: "failed", code, currentVersion: "0.1.0", targetVersion: "0.2.0" }),
      });
      expect(updateSuperseded(caught), `${code} survived the host catching up`).toBe(true);
    }
    // A rollback is reported by the OLD binary, so it is the same shape of stale.
    expect(
      updateSuperseded(
        host({
          agentVersion: "0.3.0",
          lastUpdate: status({ phase: "rolledBack", currentVersion: "0.1.0", targetVersion: "0.2.0" }),
        }),
      ),
    ).toBe(true);
  });

  it("KEEPS a failure the host has not caught up with", () => {
    /**
     * ⚠ THE LOAD-BEARING HALF. The line exists because a rollout that silently did
     * nothing is invisible otherwise — the version simply never changes, which reads as
     * "the button did nothing". Hiding one of THOSE would be a worse bug than the one
     * being fixed, so this is what stops the rule widening into it.
     */
    const stuck = host({
      agentVersion: "0.1.0",
      lastUpdate: status({ phase: "failed", code: "VERIFY_FAILED", currentVersion: "0.1.0", targetVersion: "0.2.0" }),
    });
    expect(updateSuperseded(stuck)).toBe(false);
  });

  it("says nothing about a job that has not ended, or ended well", () => {
    // In-flight and `done` are not alarms; `updateInFlight` owns the first and the cell
    // paints the second in muted text. Claiming them here would erase a live progress
    // readout mid-update, which is the one time the line matters most.
    for (const phase of ["accepted", "downloading", "verifying", "swapping", "restarting", "done"] as const) {
      const running = host({
        agentVersion: "0.2.0",
        lastUpdate: status({ phase, currentVersion: "0.2.0", targetVersion: "0.2.0" }),
      });
      expect(updateSuperseded(running), `${phase} was treated as a spent failure`).toBe(false);
    }
    expect(updateSuperseded(host({ lastUpdate: null }))).toBe(false);
  });

  it("keeps the line when it cannot prove the host caught up", () => {
    // Unreadable is not evidence. A development build, a target the agent never named,
    // a host that has not reported a version — every one of them keeps the failure
    // visible, because the cost of a stale line is noise and the cost of a hidden one
    // is a fleet that looks healthy while a rollout is stuck.
    const cases: Partial<HostView>[] = [
      { agentVersion: "0.1.0-dev+g1a2b3c", lastUpdate: status({ phase: "failed", targetVersion: "not-a-version" }) },
      { agentVersion: null, lastUpdate: status({ phase: "failed", targetVersion: "0.2.0" }) },
      { agentVersion: "0.9.9", lastUpdate: status({ phase: "failed", targetVersion: null }) },
    ];
    for (const overrides of cases) {
      expect(updateSuperseded(host(overrides)), JSON.stringify(overrides)).toBe(false);
    }
  });
});

describe("[TC-PDHOST-023] the percentage stops where it stops meaning something", () => {
  const status = (phase: UpdateStatus["phase"], progressPct: number | null): UpdateStatus =>
    ({
      commandId: "c1",
      phase,
      progressPct,
      currentVersion: "0.1.3",
      targetVersion: "0.1.6",
      code: null,
      message: "",
      shellPanes: 0,
      sessionPanes: 0,
    }) as UpdateStatus;

  it("shows it while downloading, because there it is progress", () => {
    expect(updateProgressPct(status("downloading", 42))).toBe(42);
    expect(updateProgressPct(status("downloading", 0))).toBe(0);
  });

  it("drops it once the agent pins it at 100", () => {
    // ⚠ THE MISREADING THIS FIXES. `progressPct` is DOWNLOAD progress: the agent
    // sets 100 when `verifying` starts and leaves it there through `swapping` and
    // `restarting`. `agent.phase.restarting` beside "100%" reads as "finished" and it is not —
    // `restarting` is the probation window, the one phase that can still roll the
    // host back. Measured in production during the 0.1.3 → 0.1.6 rollout.
    expect(updateProgressPct(status("verifying", 100))).toBeNull();
    expect(updateProgressPct(status("swapping", 100))).toBeNull();
    expect(updateProgressPct(status("restarting", 100))).toBeNull();
  });

  it("says nothing about a job that is over", () => {
    expect(updateProgressPct(status("done", 100))).toBeNull();
    expect(updateProgressPct(status("failed", 100))).toBeNull();
    expect(updateProgressPct(null)).toBeNull();
  });
});

/**
 * What a SIDEBAR card says, which is a third screen asking the same question — and
 * the reason this file exists rather than the logic living in a component.
 */
describe("[TC-PDWEB-028] cardUpdate", () => {
  it("offers an update for a host that is behind", () => {
    expect(cardUpdate(host())).toEqual({ kind: "offer", version: "0.2.0" });
  });

  it("says nothing when there is nothing to say", () => {
    expect(cardUpdate(host({ agentVersionState: "current" }))).toBeNull();
    // `ahead` is a developer on a local build; "update" would silently downgrade them.
    expect(cardUpdate(host({ agentVersionState: "ahead" }))).toBeNull();
    // A disabled host is not being asked anything; the card's mark already says so.
    expect(cardUpdate(host({ enabled: false }))).toBeNull();
    // Offline already reads "stopped"; an update offer beside it contradicts that.
    expect(cardUpdate(host({ online: false }))).toBeNull();
  });

  it("marks an incompatible agent differently from a merely old one", () => {
    // Outdated is advisory; incompatible means the host is already unable to talk to
    // this server, so the two must not draw the same shape.
    expect(cardUpdate(host({ agentVersionState: "incompatible" }))?.kind).toBe("urgent");
  });

  /**
   * ⚠ THE ORDERING CLAIM, AND THE ONE A NAIVE IMPLEMENTATION GETS WRONG. `restarting`
   * IS the probation window: the agent is being replaced and its heartbeat can lapse,
   * so a host in flight is very often offline at that exact moment. Checking `online`
   * first would make the mark blink out while the operator is watching it work.
   */
  it("reports a job in flight even when the host has gone quiet", () => {
    const inFlight = host({
      online: false,
      lastUpdate: { phase: "restarting", targetVersion: "0.2.0" } as UpdateStatus,
    });
    expect(cardUpdate(inFlight)).toEqual({ kind: "busy", phase: "restarting", version: "0.2.0" });
  });

  /**
   * ⚠ `unknown` IS TWO SITUATIONS SHARING ONE STATE (an unreadable version, and
   * nothing published for this platform). Splitting them on whether a target exists
   * is what keeps the card honest: a mark that cannot name where it leads would
   * render "→ —" and earn AGENT_RELEASE_UNAVAILABLE if pressed.
   */
  it("offers a way out of an unreadable version, but not out of an unpublished platform", () => {
    expect(cardUpdate(host({ agentVersionState: "unknown", agentVersion: null }))).toEqual({
      kind: "offer",
      version: "0.2.0",
    });
    expect(cardUpdate(host({ agentVersionState: "unknown", latestAgentVersion: null }))).toBeNull();
  });

  /**
   * ⚠ NOT `updateSkip()`. That is the BATCH rule — it excludes every `unknown` host
   * because "a batch declines to guess" — and delegating to it here would strand
   * exactly the hosts with no other way out. This test is what fails if somebody
   * "simplifies" the two into one.
   */
  it("does not inherit the batch rule's refusal to guess", () => {
    const unreadable = host({ agentVersionState: "unknown", agentVersion: null });
    expect(updateSkip(unreadable)).toBe("unknown");
    expect(cardUpdate(unreadable)).not.toBeNull();
  });
});
