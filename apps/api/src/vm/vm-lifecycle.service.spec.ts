import { describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { machineName } from "./vm-lifecycle.service";
import { ORG, SERVER_URL, addHost, linkedMachine, providerInput, vmHarness, type VmHarness } from "./testing/vm-harness";

const alice = { id: "user-alice", name: "Alice" };

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function provider(harness: VmHarness, overrides: Parameters<typeof providerInput>[0] = {}): Promise<string> {
  return (await harness.providers.create(ORG, providerInput(overrides))).id;
}

function request(providerId: string, key = "create-key-1", label = "Build Box") {
  return { providerId, label, template: null, cores: 4, memoryMb: 8192, idempotencyKey: key };
}

async function hostGone(harness: VmHarness, hostId: string): Promise<boolean> {
  return (await failure(harness.hosts.get(ORG, hostId))).code === "HOST_NOT_FOUND";
}

describe("VmLifecycleService — create", () => {
  it("[TC-PDVM-028] takes the first id with no machine and no backup, clones, configures, hands over the code, starts, waits for the agent and clears the code", async () => {
    const harness = vmHarness();
    // 500 is another host's machine, 501 is held by a machine these credentials cannot see,
    // 502 has a backup left from an old machine: 503 is the first id nothing remembers.
    await linkedMachine(harness, "running");
    const providerId = (await harness.providerRows.find())[0]?.id ?? "";
    harness.driver.hidden.add(501);
    harness.driver.storages = [{ node: "n1", id: "pbs", type: "pbs", content: ["backup"] }, { node: "n1", id: "local-lvm", type: "lvmthin", content: ["images"] }];
    harness.driver.storedBackups.add("pbs/502");

    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    expect(created.vm).toMatchObject({ origin: "created", externalId: "503", name: "build-box", operation: { action: "create", step: "clone", requestedBy: { name: "Alice" } } });
    expect((await harness.hosts.get(ORG, created.hostId)).label).toBe("Build Box");
    await harness.operations.settled();

    const steps = harness.driver.calls.filter((call) => !call.startsWith("poll") && !call.startsWith("lastBackup") && !call.startsWith("free"));
    expect(steps).toEqual(["discover", "status 503", "clone 9001->503", "configure 503", "configure 503", "status 503", "start 503", "configure 503", "status 503"]);
    // Only the storage that holds backups was asked about each id.
    expect(harness.driver.calls.filter((call) => call.startsWith("lastBackup"))).toEqual(["lastBackup 502", "lastBackup 503"]);

    const [sizing, handOver, cleared] = harness.driver.configured.filter((entry) => entry.vmid === 503).map((entry) => entry.settings);
    expect(sizing).toMatchObject({ cores: 4, memoryMb: 8192, balloonMb: 8192, tags: ["pdmux"], description: `pdmux host ${created.hostId}` });
    expect(handOver?.firmware).toEqual({ serial: harness.enrollment.minted[0]?.code ?? "", sku: SERVER_URL });
    expect(harness.enrollment.minted).toEqual([{ hostId: created.hostId, code: "code-1-for-test", actorId: alice.id }]);
    expect(cleared?.firmware).toBeNull();

    const view = await harness.hosts.getView(ORG, created.hostId);
    expect(view.vm).toMatchObject({ state: "running", operation: null, error: null, origin: "created" });
    expect(view.vm?.available).toMatchObject({ delete: true, enroll: false });
    expect(harness.audits.map((entry) => entry.action)).toEqual(["vm.create.completed"]);
  });

  it("[TC-PDVM-028] tags a created machine for sleep when the provider fences hibernation, and uses the provider's address for enrollment", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness, { sleepRequiresTag: "on-demand", enrollUrl: "http://10.0.0.5:5201" });
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    const settings = harness.driver.configured.map((entry) => entry.settings);
    expect(settings[0]?.tags).toEqual(["pdmux", "on-demand"]);
    expect(settings[1]?.firmware?.sku).toBe("http://10.0.0.5:5201");
    expect((await harness.hosts.getView(ORG, created.hostId)).vm?.available.hibernate).toBe(true);
  });

  it("[TC-PDVM-028] names the machine as a DNS label from the host's label", () => {
    expect(machineName("Build Box", 503)).toBe("build-box");
    expect(machineName("  ci__runner.01 ", 503)).toBe("ci-runner-01");
    expect(machineName("★ ★", 507)).toBe("pdmux-507");
    expect(machineName("x".repeat(80), 503)).toHaveLength(63);
  });

  it("[TC-PDVM-028] refuses when every id in the range is taken, and creates no host", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness, { vmidMin: 500, vmidMax: 501 });
    harness.driver.hidden.add(500);
    harness.driver.hidden.add(501);
    expect((await failure(harness.lifecycle.create(ORG, request(providerId), alice))).code).toBe("VM_ID_RANGE_FULL");
    expect(await harness.hostRows.find()).toEqual([]);
  });

  it("[TC-PDVM-029] a clone the provider refuses leaves nothing: no machine row, no host", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    harness.driver.failClone = new AppException("VM_PROVIDER_FORBIDDEN", "no", 403);
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    expect(await hostGone(harness, created.hostId)).toBe(true);
    expect(await harness.machineRows.find()).toEqual([]);
    expect(harness.published.at(-1)).toEqual({ type: "host.removed", hostId: created.hostId });
    expect(harness.audits).toMatchObject([{ action: "vm.create.failed", metadata: { errorCode: "VM_PROVIDER_FORBIDDEN" } }]);
  });

  it("[TC-PDVM-029] a clone task that fails without leaving a machine is abandoned the same way", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    harness.driver.failAction.set("clone", "VM_TASK_FAILED");
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    expect(await hostGone(harness, created.hostId)).toBe(true);
  });

  it("[TC-PDVM-029] a failure after the clone keeps the machine and its host, in error, to be deleted or retried", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    harness.driver.failAction.set("start", "VM_TASK_FAILED");
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    const view = await harness.hosts.getView(ORG, created.hostId);
    expect(view.vm).toMatchObject({ externalId: "500", operation: null, error: { code: "VM_TASK_FAILED" }, state: "stopped" });
    expect(view.vm?.available.delete).toBe(true);
    expect(harness.driver.machines.has(500)).toBe(true);
  });

  it("[TC-PDVM-029] never adopts a machine someone else put at the id after it was checked", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    // Not ours: made at 500 between the id check (which still said free) and the clone.
    harness.driver.add(500, "running", { name: "someone-elses" });
    harness.driver.vmidFree = async () => true;
    const created = await harness.lifecycle.create(ORG, { ...request(providerId), label: "mine" }, alice);
    await harness.operations.settled();
    expect(await hostGone(harness, created.hostId)).toBe(true);
    expect(harness.driver.machines.get(500)?.name).toBe("someone-elses");
    expect(harness.driver.calls.filter((call) => call.startsWith("clone"))).toEqual([]);
  });

  it("[TC-PDVM-030] an agent that never enrolls ends in ENROLL_TIMEOUT; a retry mints a new code, restarts the machine and finishes", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    harness.enrollment.autoEnroll = false;
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    let view = await harness.hosts.getView(ORG, created.hostId);
    expect(view.vm).toMatchObject({ state: "running", error: { code: "VM_ENROLL_TIMEOUT" }, operation: null });
    expect(view.vm?.available.enroll).toBe(true);

    harness.enrollment.autoEnroll = true;
    harness.driver.calls.length = 0;
    const accepted = await harness.lifecycle.reenroll(ORG, created.hostId, alice);
    expect(accepted.operation).toMatchObject({ action: "enroll", step: "firmware" });
    await harness.operations.settled();

    expect(harness.enrollment.minted.map((entry) => entry.code)).toEqual(["code-1-for-test", "code-2-for-test"]);
    const firmware = harness.driver.configured.map((entry) => entry.settings.firmware).filter((value) => value !== undefined);
    expect(firmware).toEqual([
      { serial: "code-1-for-test", sku: SERVER_URL },
      { serial: "code-2-for-test", sku: SERVER_URL },
      null,
    ]);
    // A running machine reads new firmware on a fresh boot.
    expect(harness.driver.calls).toContain("reboot 500");
    view = await harness.hosts.getView(ORG, created.hostId);
    expect(view.vm).toMatchObject({ error: null, operation: null });
    expect(view.vm?.available.enroll).toBe(false);
  });

  it("[TC-PDVM-030] offers no retry to a machine that enrolled, or to one pdmux did not create", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    expect((await failure(harness.lifecycle.reenroll(ORG, hostId, alice))).code).toBe("VM_ACTION_NOT_AVAILABLE");
  });

  it("[TC-PDVM-031] the same key twice — at once or later — makes one machine and one host", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    const [first, second] = await Promise.all([
      harness.lifecycle.create(ORG, request(providerId, "same-key-1"), alice),
      harness.lifecycle.create(ORG, request(providerId, "same-key-1"), alice),
    ]);
    await harness.operations.settled();
    const again = await harness.lifecycle.create(ORG, request(providerId, "same-key-1"), alice);
    expect(second.hostId).toBe(first.hostId);
    expect(again.hostId).toBe(first.hostId);
    expect(harness.driver.calls.filter((call) => call.startsWith("clone"))).toHaveLength(1);
    expect(await harness.hostRows.find()).toHaveLength(1);
    // A different key is a different machine.
    await harness.lifecycle.create(ORG, request(providerId, "other-key-2", "second"), alice);
    await harness.operations.settled();
    expect(await harness.hostRows.find()).toHaveLength(2);
  });

  it("[TC-PDVM-028] does not call a machine being created missing before its clone ends", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness);
    harness.driver.autoFinish = false;
    harness.clock.paused = true;
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    const row = (await harness.providerRows.find())[0];
    if (!row) throw new Error("no provider");
    await harness.operations.reconcileProvider(row);
    expect((await harness.hosts.getView(ORG, created.hostId)).vm?.state).toBe("unknown");
    harness.driver.autoFinish = true;
    harness.driver.finishAll();
    await harness.operations.settled();
    expect((await harness.hosts.getView(ORG, created.hostId)).vm?.state).toBe("running");
  });
});

describe("VmLifecycleService — platform defaults", () => {
  it("[TC-PDVM-039] with nothing named, takes the template tagged pdmux-template and the pdmux pool, and grows the disk", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness, { defaultTemplate: null, defaultPool: null, defaultDiskGb: 64 });
    harness.driver.templates = [
      { ref: { node: "n1", vmid: 9001 }, name: "plain", tags: [] },
      { ref: { node: "n1", vmid: 9002 }, name: "pdmux-base", tags: ["pdmux-template"] },
    ];
    harness.driver.pools = ["other", "pdmux"];
    const created = await harness.lifecycle.create(ORG, { ...request(providerId), cores: null, memoryMb: null }, alice);
    await harness.operations.settled();
    expect(harness.driver.calls).toContain("clone 9002->500");
    expect(harness.driver.clonedInto.get(500)).toBe("pdmux");
    // The template's 24 GiB grows to the default before the first boot.
    expect(harness.driver.calls.indexOf("resize 500 64")).toBeLessThan(harness.driver.calls.indexOf("start 500"));
    expect(harness.driver.disks.get(500)).toBe(64);
    expect((await harness.hosts.getView(ORG, created.hostId)).vm).toMatchObject({ state: "running", error: null });
  });

  it("[TC-PDVM-039] leaves a template disk that is already larger, and no pool when the cluster has none named pdmux", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness, { defaultPool: null, defaultDiskGb: 64 });
    harness.driver.cloneDiskGb = 128;
    await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    expect(harness.driver.disks.get(500)).toBe(128);
    expect(harness.driver.clonedInto.get(500)).toBeNull();
  });

  it("[TC-PDVM-039] asks for a template instead of guessing when none, or several, carry the tag — and makes no host", async () => {
    const harness = vmHarness();
    const providerId = await provider(harness, { defaultTemplate: null });
    expect((await failure(harness.lifecycle.create(ORG, request(providerId), alice))).code).toBe("VM_TEMPLATE_REQUIRED");
    harness.driver.templates = [
      { ref: { node: "n1", vmid: 9002 }, name: "a", tags: ["pdmux-template"] },
      { ref: { node: "n1", vmid: 9003 }, name: "b", tags: ["pdmux-template"] },
    ];
    const several = await failure(harness.lifecycle.create(ORG, request(providerId, "create-key-2"), alice));
    expect(several.code).toBe("VM_TEMPLATE_REQUIRED");
    expect(several.details).toEqual({ tagged: ["a", "b"] });
    expect(await harness.hostRows.find()).toEqual([]);
  });
});

describe("VmLifecycleService — delete", () => {
  async function createdMachine(harness: VmHarness): Promise<{ hostId: string }> {
    const providerId = await provider(harness);
    const created = await harness.lifecycle.create(ORG, request(providerId), alice);
    await harness.operations.settled();
    harness.driver.calls.length = 0;
    harness.audits.length = 0;
    return { hostId: created.hostId };
  }

  it("[TC-PDVM-033] deletes only machines pdmux created; a linked one can only be unlinked", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    expect((await failure(harness.lifecycle.remove(ORG, hostId, "vm-500", alice))).code).toBe("VM_NOT_CREATED_BY_PDMUX");
    expect(harness.driver.calls).toEqual([]);

    const created = await createdMachine(vmHarness());
    expect(created.hostId).toBeTruthy();
  });

  it("[TC-PDVM-033] a created machine's host cannot be removed or unlinked on its own", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    expect((await failure(harness.hosts.remove(ORG, hostId))).code).toBe("VM_DELETE_REQUIRED");
    expect((await failure(harness.machines.unlink(ORG, hostId))).code).toBe("VM_CREATED_BY_PDMUX");
  });

  it("[TC-PDVM-034] a name that does not match is refused before the provider is asked", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    expect((await failure(harness.lifecycle.remove(ORG, hostId, "build-bo", alice))).code).toBe("VM_DELETE_NAME_MISMATCH");
    expect(harness.driver.calls).toEqual([]);
    expect((await harness.hosts.getView(ORG, hostId)).vm?.operation).toBeNull();
  });

  it("[TC-PDVM-035] stops a running machine, deletes it with its disks, then removes the host", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    const accepted = await harness.lifecycle.remove(ORG, hostId, " build-box ", alice);
    expect(accepted.operation).toMatchObject({ action: "delete", step: "stop" });
    await harness.operations.settled();
    expect(harness.driver.calls.filter((call) => !call.startsWith("poll"))).toEqual(["status 500", "status 500", "stop 500", "status 500", "remove 500"]);
    expect(harness.driver.machines.has(500)).toBe(false);
    expect(await hostGone(harness, hostId)).toBe(true);
    expect(await harness.machineRows.find()).toEqual([]);
    expect(harness.published.at(-1)).toEqual({ type: "host.removed", hostId });
    expect(harness.audits).toMatchObject([{ action: "vm.delete.completed", actorName: "Alice" }]);
  });

  it("[TC-PDVM-035] wakes a hibernated machine first: its saved memory locks it against deletion", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    const vm = harness.driver.machines.get(500);
    if (vm) vm.state = "hibernated";
    await harness.lifecycle.remove(ORG, hostId, "build-box", alice);
    await harness.operations.settled();
    expect(harness.driver.calls.filter((call) => /^(start|stop|remove) /.test(call))).toEqual(["start 500", "stop 500", "remove 500"]);
    expect(await hostGone(harness, hostId)).toBe(true);
  });

  it("[TC-PDVM-035] when the provider fails to delete, the host stays with the error so it can be tried again", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    harness.driver.failAction.set("remove", "VM_LOCKED");
    await harness.lifecycle.remove(ORG, hostId, "build-box", alice);
    await harness.operations.settled();
    const view = await harness.hosts.getView(ORG, hostId);
    expect(view.vm).toMatchObject({ operation: null, error: { code: "VM_LOCKED" } });
    expect(view.vm?.available.delete).toBe(true);
    expect(harness.audits).toMatchObject([{ action: "vm.delete.failed" }]);

    // Again, and this time it goes.
    await harness.lifecycle.remove(ORG, hostId, "build-box", alice);
    await harness.operations.settled();
    expect(await hostGone(harness, hostId)).toBe(true);
  });

  it("[TC-PDVM-035] a machine already gone at the provider still takes its host with it", async () => {
    const harness = vmHarness();
    const { hostId } = await createdMachine(harness);
    harness.driver.machines.delete(500);
    await harness.lifecycle.remove(ORG, hostId, "build-box", alice);
    await harness.operations.settled();
    expect(await hostGone(harness, hostId)).toBe(true);
  });

  it("[TC-PDVM-033] a host that is not this scope's is not found", async () => {
    const harness = vmHarness();
    const host = await addHost(harness, "plain");
    expect((await failure(harness.lifecycle.remove(ORG, host.id, "plain", alice))).code).toBe("VM_NOT_LINKED");
  });
});
