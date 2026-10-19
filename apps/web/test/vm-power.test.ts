/**
 * The one set of rules every screen asks about a host's machine — pane header, veil, card and
 * host page. If these disagree with each other the panes stop agreeing too, so they are pinned
 * here rather than in each component.
 */
import { describe, expect, it } from "vitest";
import { gridHosts } from "$lib/dashboard/map";
import type { HostView } from "$lib/dashboard/types";
import { attachedClients, elapsedSeconds, powerItems, vmPhase, vmReachable } from "$lib/vm/power";
import type { HostVmView } from "$lib/vm/types";

const ALL = { start: true, hibernate: true, shutdown: true, stop: true, reboot: true, reset: true, delete: false, enroll: false };

function vm(over: Partial<HostVmView> = {}): HostVmView {
  return {
    provider: { id: "p1", kind: "proxmox", name: "lab" },
    origin: "linked",
    name: "vm-500",
    location: "n1",
    externalId: "500",
    state: "running",
    observedAt: "2026-10-19T09:00:00.000Z",
    operation: null,
    error: null,
    available: { ...ALL, start: false },
    ...over,
  };
}

describe("[TC-PDVM-020] a machine's state becomes the same display and menu everywhere", () => {
  it("puts the state's default first and the forced changes last, for an administrator", () => {
    expect(powerItems(vm(), true).map((item) => [item.label, item.kind, item.confirm])).toEqual([
      ["hibernate", "primary", "simple"],
      ["reboot", "normal", "simple"],
      ["shutdown", "normal", "simple"],
      ["stop", "danger", "warn"],
      ["reset", "danger", "warn"],
    ]);
  });

  it("leaves the forced changes out for a member, and offers shut down first when sleep is fenced", () => {
    expect(powerItems(vm(), false).map((item) => item.action)).toEqual(["hibernate", "reboot", "shutdown"]);
    const fenced = vm({ available: { ...ALL, start: false, hibernate: false } });
    expect(powerItems(fenced, false).map((item) => [item.action, item.kind])).toEqual([
      ["reboot", "primary"],
      ["shutdown", "normal"],
    ]);
  });

  it("calls starting a sleeping machine waking it, and asks nothing before it", () => {
    const asleep = vm({ state: "hibernated", available: { ...ALL, start: true, hibernate: false, shutdown: false, reboot: false, stop: false, reset: false } });
    expect(powerItems(asleep, false)).toEqual([{ action: "start", kind: "primary", label: "wake", confirm: "none" }]);
    const off = vm({ state: "stopped", available: asleep.available });
    expect(powerItems(off, false)[0]?.label).toBe("start");
  });

  it("offers nothing while a change runs, and says so first", () => {
    const busy = vm({ operation: { action: "reboot", step: "wait", startedAt: "2026-10-19T09:00:00.000Z", requestedBy: { id: "u1", name: "Alice" } } });
    expect(powerItems(busy, true)).toEqual([]);
    expect(vmPhase(busy)).toBe("busy");
    expect(elapsedSeconds(busy, Date.parse("2026-10-19T09:00:12.400Z"))).toBe(12);
    expect(elapsedSeconds(busy, Date.parse("2026-10-19T08:59:58.000Z"))).toBe(0);
  });

  it("names the phase a screen should lead with", () => {
    expect(vmPhase(vm({ state: "hibernated" }))).toBe("asleep");
    expect(vmPhase(vm({ state: "stopped" }))).toBe("off");
    expect(vmPhase(vm({ state: "missing" }))).toBe("missing");
    expect(vmPhase(vm({ error: { code: "VM_TASK_TIMEOUT", at: "2026-10-19T09:00:00.000Z" } }))).toBe("error");
    expect(vmPhase(vm())).toBe("ready");
  });

  it("takes a sleeping machine's panes off line at once, before three heartbeats are missed", () => {
    const host = (machine?: HostVmView): HostView => ({ id: "h1", label: "box", enabled: true, online: true, sessions: [], ...(machine ? { vm: machine } : {}) }) as unknown as HostView;
    expect(gridHosts([host()])[0]?.online).toBe(true);
    expect(gridHosts([host(vm())])[0]?.online).toBe(true);
    expect(gridHosts([host(vm({ state: "hibernated" }))])[0]?.online).toBe(false);
    expect(gridHosts([host(vm({ operation: { action: "hibernate", step: "request", startedAt: "2026-10-19T09:00:00.000Z", requestedBy: { id: null, name: null } } }))])[0]?.online).toBe(false);
    // Waking: the machine is coming, but the terminals answer once the agent is back.
    expect(gridHosts([host(vm({ state: "hibernated", operation: { action: "start", step: "wait", startedAt: "2026-10-19T09:00:00.000Z", requestedBy: { id: null, name: null } } }))])[0]?.online).toBe(false);
    // A provider that cannot be asked says nothing about the machine; the heartbeat decides.
    expect(vmReachable(vm({ state: "unknown" }))).toBe(true);
  });

  it("[TC-PDVM-028] keeps a machine's panes off line while it is being created, re-enrolled or deleted", () => {
    const during = (action: "create" | "enroll" | "delete") =>
      vm({ operation: { action, step: "start", startedAt: "2026-10-19T09:00:00.000Z", requestedBy: { id: null, name: null } } });
    expect(vmReachable(during("create"))).toBe(false);
    expect(vmReachable(during("enroll"))).toBe(false);
    expect(vmReachable(during("delete"))).toBe(false);
    expect(powerItems(during("create"), true)).toEqual([]);
  });

  it("counts every client attached to the machine's sessions", () => {
    expect(attachedClients([{ attached: 2 }, { attached: 1 }, { attached: 0 }])).toBe(3);
    expect(attachedClients([])).toBe(0);
  });
});
