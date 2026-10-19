import { describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { availableActions } from "./host-vms.service";
import { ORG, OTHER_ORG, addHost, providerInput, vmHarness } from "./testing/vm-harness";

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("HostVmsService", () => {
  it("[TC-PDVM-008] links an existing machine to a host and shows it on that host's view", async () => {
    const harness = vmHarness();
    const provider = await harness.providers.create(ORG, providerInput());
    const host = await addHost(harness, "dev-box");
    harness.driver.add(500, "hibernated", { name: "dev-box-vm", tags: ["on-demand"] });

    const linked = await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });

    expect(linked).toMatchObject({ origin: "linked", name: "dev-box-vm", location: "n1", externalId: "500", state: "hibernated", operation: null });
    expect(harness.published).toEqual([{ type: "host.vm", hostId: host.id }]);
    const [view] = await harness.hosts.list(ORG);
    expect(view?.vm?.provider).toEqual({ id: provider.id, kind: "proxmox", name: "lab" });
    expect((await harness.hosts.getView(ORG, host.id)).vm?.state).toBe("hibernated");
  });

  it("[TC-PDVM-008] refuses a foreign host, a second machine, a machine linked elsewhere, an unseen machine and a template", async () => {
    const harness = vmHarness();
    const provider = await harness.providers.create(ORG, providerInput());
    const first = await addHost(harness, "first");
    const second = await addHost(harness, "second");
    const foreign = await addHost(harness, "foreign", OTHER_ORG);
    harness.driver.add(500, "running");
    harness.driver.add(501, "running");
    harness.driver.add(9001, "stopped", { template: true });
    const link = (hostId: string, vmid: number) => harness.machines.link(ORG, hostId, { providerId: provider.id, node: "n1", vmid });

    expect((await failure(link(foreign.id, 500))).code).toBe("HOST_NOT_FOUND");
    await link(first.id, 500);
    expect((await failure(link(first.id, 501))).code).toBe("VM_ALREADY_LINKED");
    expect((await failure(link(second.id, 500))).code).toBe("VM_LINKED_ELSEWHERE");
    expect((await failure(link(second.id, 777))).code).toBe("VM_NOT_FOUND");
    expect((await failure(link(second.id, 9001))).code).toBe("VM_IS_TEMPLATE");
  });

  it("[TC-PDVM-008] unlinks a linked machine, but a created one only goes with its host", async () => {
    const harness = vmHarness();
    const provider = await harness.providers.create(ORG, providerInput());
    const host = await addHost(harness, "box");
    harness.driver.add(500, "running");
    await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });

    expect(await harness.machines.unlink(ORG, host.id)).toEqual({ hostId: host.id, name: "vm-500" });
    expect(harness.machineRows.rows).toHaveLength(0);
    // The machine itself is untouched by an unlink.
    expect(harness.driver.machines.has(500)).toBe(true);

    await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });
    const row = harness.machineRows.rows[0];
    if (row) row.origin = "created";
    expect((await failure(harness.machines.unlink(ORG, host.id))).code).toBe("VM_CREATED_BY_PDMUX");
    expect((await failure(harness.hosts.remove(ORG, host.id))).code).toBe("VM_DELETE_REQUIRED");
    // The deletion path itself may remove the host.
    await harness.machines.releaseHost(host.id, () => harness.hosts.remove(ORG, host.id));
    expect(harness.hostRows.rows).toHaveLength(0);
  });

  it("[TC-PDVM-008] keeps a host with a machine in its scope", async () => {
    const harness = vmHarness();
    const provider = await harness.providers.create(ORG, providerInput());
    const host = await addHost(harness, "box");
    harness.driver.add(500, "running");
    await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });
    expect((await failure(harness.hosts.move(ORG, host.id, "someone@example.com"))).code).toBe("VM_HOST_MOVE_BLOCKED");
  });

  it("[TC-PDVM-014] offers hibernate only to machines carrying the configured tag, and nothing while a change runs", () => {
    const running = { observedState: "running" as const, operation: null, origin: "linked" as const, tags: ["on-demand"], errorCode: null };
    expect(availableActions(running, { sleepRequiresTag: "on-demand" }).hibernate).toBe(true);
    expect(availableActions({ ...running, tags: [] }, { sleepRequiresTag: "on-demand" })).toMatchObject({ hibernate: false, shutdown: true });
    expect(availableActions({ ...running, tags: [] }, { sleepRequiresTag: null }).hibernate).toBe(true);
    expect(availableActions({ ...running, operation: "reboot" }, { sleepRequiresTag: null })).toEqual({
      start: false, hibernate: false, shutdown: false, stop: false, reboot: false, reset: false, delete: false, enroll: false,
    });
    expect(availableActions({ ...running, observedState: "hibernated" }, { sleepRequiresTag: null })).toMatchObject({ start: true, shutdown: false, delete: false });
    expect(availableActions({ ...running, observedState: "stopped", origin: "created" }, { sleepRequiresTag: null })).toMatchObject({ start: true, delete: true });
  });
});
