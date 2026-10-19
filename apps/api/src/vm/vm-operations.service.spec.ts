import { describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { ORG, linkedMachine, vmHarness } from "./testing/vm-harness";

const alice = { id: "user-alice", name: "Alice" };
const bob = { id: "user-bob", name: "Bob" };

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("VmOperationsService", () => {
  it("[TC-PDVM-009] runs a power change through the provider and ends with the state it produced", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running", { sleepRequiresTag: null });

    const accepted = await harness.operations.power(ORG, hostId, "hibernate", alice);
    expect(accepted.operation).toMatchObject({ action: "hibernate", requestedBy: { id: alice.id, name: "Alice" } });
    await harness.operations.settled();

    expect(harness.driver.calls.filter((call) => !call.startsWith("poll"))).toEqual(["status 500", "hibernate 500", "status 500"]);
    const view = await harness.hosts.getView(ORG, hostId);
    expect(view.vm).toMatchObject({ state: "hibernated", operation: null, error: null });
    expect(view.vm?.available).toMatchObject({ start: true, hibernate: false });
  });

  it("[TC-PDVM-011] starts a hibernated machine, which resumes it", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "hibernated");
    await harness.operations.power(ORG, hostId, "start", alice);
    await harness.operations.settled();
    expect((await harness.hosts.getView(ORG, hostId)).vm?.state).toBe("running");
  });

  it("[TC-PDVM-010] lets two simultaneous requests start one change and tells the other who is running it", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    harness.driver.autoFinish = false;
    // Time stands still while the task runs, so it is still running when the third request comes.
    harness.clock.paused = true;

    const results = await Promise.allSettled([
      harness.operations.power(ORG, hostId, "reboot", alice),
      harness.operations.power(ORG, hostId, "shutdown", bob),
    ]);

    const accepted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const error = refused[0]?.reason as AppException;
    expect(error.code).toBe("VM_OPERATION_IN_PROGRESS");
    expect(error.details).toMatchObject({ action: "reboot", requestedBy: "Alice" });
    // Exactly one task reached the provider (the request runs after the 202, so wait for it).
    for (let tick = 0; tick < 50 && !harness.driver.calls.includes("reboot 500"); tick++) await Bun.sleep(1);
    expect(harness.driver.calls.filter((call) => /^(reboot|shutdown) /.test(call))).toEqual(["reboot 500"]);

    // While it runs, a third request is refused at once and no state allows anything.
    expect((await failure(harness.operations.power(ORG, hostId, "stop", bob))).code).toBe("VM_OPERATION_IN_PROGRESS");
    expect((await harness.hosts.getView(ORG, hostId)).vm?.available.shutdown).toBe(false);
    harness.driver.finishAll();
    harness.clock.paused = false;
    await harness.operations.settled();
    expect((await harness.hosts.getView(ORG, hostId)).vm?.operation).toBeNull();
  });

  it("[TC-PDVM-012] decides on the provider's current state, not on a minute-old screen", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    // Somebody shut it down from the provider's own console.
    const vm = harness.driver.machines.get(500);
    if (vm) vm.state = "stopped";

    const error = await failure(harness.operations.power(ORG, hostId, "shutdown", alice));
    expect(error.code).toBe("VM_ACTION_NOT_AVAILABLE");
    expect(error.details).toMatchObject({ action: "shutdown", state: "stopped" });
    expect((await harness.hosts.getView(ORG, hostId)).vm?.state).toBe("stopped");
  });

  it("[TC-PDVM-012] writes what the provider shows on every reconcile, including machines that are gone", async () => {
    const harness = vmHarness();
    const { hostId, providerId } = await linkedMachine(harness, "running");
    const provider = await harness.providers.row(ORG, providerId);
    const vm = harness.driver.machines.get(500);
    if (vm) vm.state = "hibernated";

    await harness.operations.reconcileProvider(provider);
    expect((await harness.hosts.getView(ORG, hostId)).vm?.state).toBe("hibernated");
    expect(harness.published).toEqual([{ type: "host.vm", hostId }]);

    // Nothing changed: nothing is announced.
    await harness.operations.reconcileProvider(provider);
    expect(harness.published).toHaveLength(1);

    harness.driver.machines.delete(500);
    await harness.operations.reconcileProvider(provider);
    expect((await harness.hosts.getView(ORG, hostId)).vm?.state).toBe("missing");
  });

  it("[TC-PDVM-012] resumes a change whose driver died, from the task it had already started", async () => {
    const harness = vmHarness();
    const { hostId, providerId } = await linkedMachine(harness, "running");
    const task = harness.driver.startTask("reboot", () => undefined);
    const row = harness.machineRows.rows[0];
    if (!row) throw new Error("no row");
    Object.assign(row, {
      operation: "reboot",
      operationStep: "wait",
      operationTask: task.id,
      operationRequestedById: alice.id,
      operationRequestedByName: alice.name,
      operationStartedAt: new Date(harness.clock.now - 10 * 60_000),
      operationUpdatedAt: new Date(harness.clock.now - 5 * 60_000),
    });

    await harness.operations.reconcileProvider(await harness.providers.row(ORG, providerId));
    await harness.operations.settled();

    // It was not asked again — the existing task was followed to its end.
    expect(harness.driver.calls.filter((call) => call.startsWith("reboot"))).toEqual([]);
    expect((await harness.hosts.getView(ORG, hostId)).vm).toMatchObject({ operation: null, error: null });
    expect(harness.audits.at(-1)).toMatchObject({ action: "vm.power.completed", actorName: "Alice" });
  });

  it("[TC-PDVM-012] gives up on a task that never ends and says so", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    harness.driver.autoFinish = false;
    await harness.operations.power(ORG, hostId, "shutdown", alice);
    await harness.operations.settled();
    const view = await harness.hosts.getView(ORG, hostId);
    expect(view.vm).toMatchObject({ operation: null, error: { code: "VM_TASK_TIMEOUT" } });
    expect(harness.audits.at(-1)).toMatchObject({ action: "vm.power.failed", metadata: { errorCode: "VM_TASK_TIMEOUT" } });
  });

  it("[TC-PDVM-012] reports the provider's refusal of a running task as the change's error", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    harness.driver.failAction.set("shutdown", "VM_TASK_TIMEOUT");
    await harness.operations.power(ORG, hostId, "shutdown", alice);
    await harness.operations.settled();
    expect((await harness.hosts.getView(ORG, hostId)).vm).toMatchObject({ state: "running", error: { code: "VM_TASK_TIMEOUT" } });
    // The next request clears the old error.
    await harness.operations.power(ORG, hostId, "reboot", alice);
    await harness.operations.settled();
    expect((await harness.hosts.getView(ORG, hostId)).vm?.error).toBeNull();
  });

  it("[TC-PDVM-013] backs up before hibernating when the newest backup is older than a day", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running", { backupBeforeSleep: "backups" });
    harness.driver.backups.set(500, harness.clock.now - 2 * 24 * 60 * 60_000);

    await harness.operations.power(ORG, hostId, "hibernate", alice);
    await harness.operations.settled();

    const order = harness.driver.calls.filter((call) => /^(backup|hibernate|lastBackup) /.test(call));
    expect(order).toEqual(["lastBackup 500", "backup 500", "hibernate 500"]);
    expect((await harness.hosts.getView(ORG, hostId)).vm?.state).toBe("hibernated");
  });

  it("[TC-PDVM-013] hibernates without a new backup when one is recent, and not at all when the backup fails", async () => {
    const recent = vmHarness();
    const first = await linkedMachine(recent, "running", { backupBeforeSleep: "backups" });
    recent.driver.backups.set(500, recent.clock.now - 60 * 60_000);
    await recent.operations.power(ORG, first.hostId, "hibernate", alice);
    await recent.operations.settled();
    expect(recent.driver.calls.filter((call) => call.startsWith("backup"))).toEqual([]);

    const failing = vmHarness();
    const second = await linkedMachine(failing, "running", { backupBeforeSleep: "backups" });
    failing.driver.failAction.set("backup", "VM_TASK_FAILED");
    await failing.operations.power(ORG, second.hostId, "hibernate", alice);
    await failing.operations.settled();
    expect(failing.driver.calls.filter((call) => call.startsWith("hibernate"))).toEqual([]);
    expect((await failing.hosts.getView(ORG, second.hostId)).vm).toMatchObject({ state: "running", error: { code: "VM_BACKUP_FAILED" } });
  });

  it("[TC-PDVM-014] refuses to hibernate a machine without the configured tag", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running", { sleepRequiresTag: "on-demand" });
    expect((await failure(harness.operations.power(ORG, hostId, "hibernate", alice))).code).toBe("VM_ACTION_NOT_AVAILABLE");
    const tagged = vmHarness();
    const other = await linkedMachine(tagged, "running", { sleepRequiresTag: "on-demand" }, ["on-demand"]);
    await tagged.operations.power(ORG, other.hostId, "hibernate", alice);
    await tagged.operations.settled();
    expect((await tagged.hosts.getView(ORG, other.hostId)).vm?.state).toBe("hibernated");
  });

  it("[TC-PDVM-018] shows the change in flight, its step and who asked, on the host's view", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    harness.driver.autoFinish = false;
    harness.clock.paused = true;
    harness.operations.power(ORG, hostId, "reboot", alice);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.operations.power(ORG, hostId, "reboot", alice).catch(() => undefined);
    const view = await harness.hosts.getView(ORG, hostId);
    expect(view.vm?.operation).toMatchObject({ action: "reboot", requestedBy: { id: alice.id, name: "Alice" } });
    expect(typeof view.vm?.operation?.startedAt).toBe("string");
    harness.driver.finishAll();
    harness.clock.paused = false;
    await harness.operations.settled();
  });

  it("[TC-PDVM-019] announces the claim, each step and the end, so every screen reloads", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running", { backupBeforeSleep: "backups" });
    await harness.operations.power(ORG, hostId, "hibernate", alice);
    await harness.operations.settled();
    // claim · backup · request · wait · end — every one is a `host.*` event the fleet stream relays.
    expect(harness.published.length).toBeGreaterThanOrEqual(4);
    expect(new Set(harness.published.map((event) => event.type))).toEqual(new Set(["host.vm"]));
    expect(new Set(harness.published.map((event) => event.hostId))).toEqual(new Set([hostId]));
  });

  it("[TC-PDVM-016] records the end of a change without the provider's credentials or task text", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    await harness.operations.power(ORG, hostId, "reboot", alice);
    await harness.operations.settled();
    const entry = harness.audits.at(-1);
    expect(entry).toMatchObject({ action: "vm.power.completed", actorId: alice.id, targetId: hostId, metadata: { action: "reboot", externalId: "500" } });
    expect(JSON.stringify(entry)).not.toContain("provider-secret-for-test");
    expect(JSON.stringify(entry)).not.toContain("UPID");
  });

  it("[TC-PDVM-012] lets one replica reconcile a provider at a time", async () => {
    const harness = vmHarness();
    const { providerId } = await linkedMachine(harness, "running");
    const now = new Date(harness.clock.now);
    expect(await harness.providers.claimLease(providerId, now, new Date(now.getTime() + 50_000))).toBe(true);
    expect(await harness.providers.claimLease(providerId, now, new Date(now.getTime() + 50_000))).toBe(false);
    expect(await harness.providers.claimLease(providerId, new Date(now.getTime() + 60_000), new Date(now.getTime() + 110_000))).toBe(true);
  });
});
