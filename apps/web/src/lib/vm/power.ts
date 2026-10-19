/**
 * What a pane, a card and a host page say and offer about a host's machine.
 *
 * ONE SET OF RULES FOR EVERY SCREEN. The pane header, the "asleep" veil, the card and the host
 * page all ask these functions, so they cannot disagree about whether a machine is asleep or
 * which button is the default — the sync the feature promises is only as good as this file
 * being the single answer. The state comes from the server (`HostView.vm`); nothing here
 * guesses ahead of it.
 */
import type { HostVmView, VmAction, VmOperationKind, VmState } from "./types";

/** Forced changes can lose unsaved work; the server keeps them for fleet administrators. */
export const FORCED_ACTIONS: ReadonlySet<VmAction> = new Set(["stop", "reset"]);

/** Changes after which the host's terminals are gone until the machine is back. */
const GOING_AWAY: ReadonlySet<VmOperationKind> = new Set(["hibernate", "shutdown", "stop", "reboot", "reset", "delete"]);

export type PowerItemKind = "primary" | "normal" | "danger";

export interface PowerItem {
  action: VmAction;
  kind: PowerItemKind;
  /** `wake` for a hibernated machine: the same `start`, said the way a person would. */
  label: VmAction | "wake";
  confirm: "none" | "simple" | "warn";
}

const ORDER: Record<VmState, VmAction[]> = {
  running: ["hibernate", "reboot", "shutdown", "stop", "reset"],
  hibernated: ["start"],
  stopped: ["start"],
  paused: ["stop", "reset"],
  unknown: [],
  missing: [],
};

/**
 * The power menu, in order: the state's default first, the forced changes last.
 *
 * "Stop" in this product means hibernate (2026-10-19 decision), so a running machine's first
 * item is hibernate — when its provider allows it; otherwise shut down is offered and stays
 * where it is. Items the person may not use are left out rather than greyed: a member has
 * nothing to do with a button only an administrator can press.
 */
export function powerItems(vm: HostVmView, canManage: boolean): PowerItem[] {
  if (vm.operation) return [];
  const items: PowerItem[] = [];
  for (const action of ORDER[vm.state]) {
    if (!vm.available[action]) continue;
    if (FORCED_ACTIONS.has(action) && !canManage) continue;
    items.push({
      action,
      kind: FORCED_ACTIONS.has(action) ? "danger" : items.length === 0 ? "primary" : "normal",
      label: action === "start" && vm.state === "hibernated" ? "wake" : action,
      confirm: action === "start" ? "none" : FORCED_ACTIONS.has(action) ? "warn" : "simple",
    });
  }
  return items;
}

/**
 * Whether the host's terminals can be expected to answer.
 *
 * ⚠ THE MACHINE KNOWS BEFORE THE HEARTBEAT DOES. A host reads offline only after three missed
 * heartbeats (15 seconds at least), so a pane would go on looking alive for that long after its
 * machine was put to sleep — and a person types into it. The machine's own state, and a change
 * that takes the terminals away, decide at once. An unreachable provider (`unknown`) says
 * nothing about the machine and leaves the heartbeat in charge.
 */
export function vmReachable(vm: HostVmView | undefined): boolean {
  if (!vm) return true;
  if (vm.operation && GOING_AWAY.has(vm.operation.action)) return false;
  return vm.state === "running" || vm.state === "unknown";
}

export type VmPhase = "busy" | "asleep" | "off" | "paused" | "missing" | "error" | "ready" | "unknown";

/** One word for what a screen should say about the machine first. */
export function vmPhase(vm: HostVmView): VmPhase {
  if (vm.operation) return "busy";
  if (vm.state === "hibernated") return "asleep";
  if (vm.state === "stopped") return "off";
  if (vm.state === "paused") return "paused";
  if (vm.state === "missing") return "missing";
  if (vm.error) return "error";
  return vm.state === "running" ? "ready" : "unknown";
}

/** Seconds since the change started, never negative (clocks differ by a little). */
export function elapsedSeconds(vm: HostVmView, now: number): number {
  if (!vm.operation) return 0;
  return Math.max(0, Math.round((now - Date.parse(vm.operation.startedAt)) / 1000));
}

/**
 * How many people are looking at this machine's sessions right now.
 *
 * `attached` is the multiplexer's own client count — every pane in every browser, and SSH
 * sessions too — so it is the honest number for "who will be cut off". `mine` is this
 * screen's panes on the host, so a person can tell their own panes from everyone else's.
 */
export function attachedClients(sessions: readonly { attached: number }[]): number {
  return sessions.reduce((total, session) => total + Math.max(0, session.attached), 0);
}

/** The card's kind of power line, or `null` for a running machine with nothing to say. */
export function cardPowerKind(vm: HostVmView | undefined): "asleep" | "off" | "busy" | "error" | "missing" | null {
  if (!vm) return null;
  switch (vmPhase(vm)) {
    case "busy": return "busy";
    case "asleep": return "asleep";
    case "off":
    case "paused": return "off";
    case "missing": return "missing";
    case "error": return "error";
    default: return null;
  }
}
