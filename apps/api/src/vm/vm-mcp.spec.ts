import { describe, expect, it, mock } from "bun:test";
import "reflect-metadata";
import { AppException } from "../common/app-exception";
import type { HostsService } from "../hosts/hosts.service";
import { ApiFleetGateway, type FleetVmTools } from "../mcp/fleet-gateway";
import type { McpUserIdentity } from "../mcp/user-mcp-keys.service";
import { VmFleetTools } from "./vm-mcp";
import { ORG, linkedMachine, providerInput, vmHarness, type VmHarness } from "./testing/vm-harness";

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error.code;
    if (error instanceof Error && "code" in error) return String((error as { code: unknown }).code);
    throw error;
  }
  throw new Error("expected a refusal");
}

function identity(tier: "read" | "operate" | "admin"): McpUserIdentity {
  return { keyId: "tok-1", userId: "user-1", organizationId: ORG, tier, effectiveTier: tier };
}

/** The gateway with only what the vm_* methods use; the rest of it is `fleet-gateway.spec.ts`'s. */
function gateway(tier: "read" | "operate" | "admin", vm: FleetVmTools | null) {
  const audit = mock();
  return { audit, gateway: new ApiFleetGateway(identity(tier), { audit, vm, origin: "https://pdmux.example.test", scopeLabel: "lab" } as never) };
}

function recordingTools(calls: string[]): FleetVmTools {
  return {
    status: async (scope, hostId) => { calls.push(`status ${scope} ${hostId}`); return {}; },
    powerPlan: async (scope, hostId, action) => { calls.push(`plan ${scope} ${hostId} ${action}`); return { willDestroy: [{ type: "x" }], reversible: true, retryWith: {} }; },
    power: async (scope, hostId, action, actor) => { calls.push(`power ${scope} ${hostId} ${action} ${actor.name}`); return { name: "vm-1" }; },
    create: async (scope, input) => { calls.push(`create ${scope} ${input.label} ${input.idempotencyKey.length > 0}`); return { hostId: "h9", label: input.label }; },
    deletePlan: async (scope, hostId) => { calls.push(`deletePlan ${scope} ${hostId}`); return { willDestroy: [], reversible: false, retryWith: {} }; },
    remove: async (scope, hostId, confirmName) => { calls.push(`remove ${scope} ${hostId} ${confirmName}`); return { name: "vm-1" }; },
  };
}

/** The harness's hosts, with sessions on the machine as a heartbeat would report them. */
function withSessions(harness: VmHarness, sessions: { name: string; attached: number }[]): HostsService {
  return {
    getView: async (scope: string, id: string) => ({ ...(await harness.hosts.getView(scope, id)), sessions }),
  } as unknown as HostsService;
}

const alice = { id: "user-1", name: "MCP" };

describe("[TC-PDVM-036] the VM tools behind MCP", () => {
  it("[TC-PDVM-036] says plainly when the server has no VM providers", async () => {
    expect(await failure(gateway("admin", null).gateway.vmStatus())).toBe("VM_PROVIDERS_UNAVAILABLE");
  });

  it("[TC-PDVM-036] passes the token's scope, names the change MCP, and refuses below each tier on its own", async () => {
    const calls: string[] = [];
    const operate = gateway("operate", recordingTools(calls));
    await operate.gateway.vmPower("h1", "hibernate");
    expect(await failure(operate.gateway.vmPower("h1", "stop"))).toBe("MCP_TIER_INSUFFICIENT");
    expect(await failure(operate.gateway.vmCreate({ label: "x" }))).toBe("MCP_TIER_INSUFFICIENT");
    expect(await failure(operate.gateway.vmDelete("h1", "vm-1"))).toBe("MCP_TIER_INSUFFICIENT");
    expect(await failure(gateway("read", recordingTools(calls)).gateway.vmPower("h1", "start"))).toBe("MCP_TIER_INSUFFICIENT");
    expect(calls).toEqual([`power ${ORG} h1 hibernate MCP`]);
    expect(operate.audit).toHaveBeenCalledWith({ tool: "vm_power", target: { type: "host", id: "h1", label: "vm-1" }, metadata: { action: "hibernate" } });

    const admin = gateway("admin", recordingTools(calls));
    await admin.gateway.vmPowerPlan("h1", "stop");
    await admin.gateway.vmCreate({ label: "build-02" });
    await admin.gateway.vmDelete("h1", "vm-1");
    expect(calls.slice(1)).toEqual([`plan ${ORG} h1 stop`, `create ${ORG} build-02 true`, `remove ${ORG} h1 vm-1`]);
    // A plan is recorded too: an abandoned attempt is an entry, not silence.
    expect(admin.audit).toHaveBeenCalledWith({ tool: "vm_power", target: { type: "host", id: "h1" }, metadata: { action: "stop", dryRun: true, confirmed: false } });
  });

  it("[TC-PDVM-036] runs a change that cuts nobody off, and describes one that would", async () => {
    const harness = vmHarness();
    const { hostId } = await linkedMachine(harness, "running");
    const quiet = new VmFleetTools({ providers: harness.providers, machines: harness.machines, operations: harness.operations, lifecycle: harness.lifecycle }, harness.hosts);
    expect(await quiet.powerPlan(ORG, hostId, "hibernate")).toBeNull();
    expect(await quiet.powerPlan(ORG, hostId, "start")).toBeNull();
    expect((await quiet.powerPlan(ORG, hostId, "stop"))?.willDestroy.map((item) => item.type)).toEqual(["guest-state"]);

    const busy = new VmFleetTools({ providers: harness.providers, machines: harness.machines, operations: harness.operations, lifecycle: harness.lifecycle }, withSessions(harness, [{ name: "main", attached: 2 }]));
    const sleep = await busy.powerPlan(ORG, hostId, "hibernate");
    expect(sleep).toMatchObject({ reversible: true, retryWith: { hostId, action: "hibernate", confirm: true } });
    expect(sleep?.willDestroy).toEqual([expect.objectContaining({ type: "terminal-connection", count: 2 })]);
    const reboot = await busy.powerPlan(ORG, hostId, "reboot");
    expect(reboot?.reversible).toBe(false);
    expect(reboot?.willDestroy.map((item) => item.type)).toEqual(["terminal-session", "terminal-connection"]);
  });

  it("[TC-PDVM-036] plans a delete only for a machine pdmux created, carrying its name to confirm with", async () => {
    const harness = vmHarness();
    const tools = new VmFleetTools({ providers: harness.providers, machines: harness.machines, operations: harness.operations, lifecycle: harness.lifecycle }, harness.hosts);
    const { hostId: linked } = await linkedMachine(harness, "running");
    expect(await failure(tools.deletePlan(ORG, linked))).toBe("VM_NOT_CREATED_BY_PDMUX");

    // One provider: the create needs no provider id.
    const created = await tools.create(ORG, { label: "build-02", idempotencyKey: "key-12345678" }, alice);
    await harness.operations.settled();
    const plan = await tools.deletePlan(ORG, created.hostId);
    expect(plan.retryWith).toEqual({ hostId: created.hostId, confirmName: "build-02", confirm: true });
    expect(plan.willDestroy[0]).toMatchObject({ type: "vm", label: "build-02" });
    await tools.remove(ORG, created.hostId, String(plan.retryWith.confirmName), alice);
    await harness.operations.settled();
    expect(await failure(harness.hosts.get(ORG, created.hostId))).toBe("HOST_NOT_FOUND");
  });

  it("[TC-PDVM-036] asks which provider when there is more than one", async () => {
    const harness = vmHarness();
    await harness.providers.create(ORG, providerInput({ name: "lab" }));
    await harness.providers.create(ORG, providerInput({ name: "office" }));
    const tools = new VmFleetTools({ providers: harness.providers, machines: harness.machines, operations: harness.operations, lifecycle: harness.lifecycle }, harness.hosts);
    expect(await failure(tools.create(ORG, { label: "x", idempotencyKey: "key-12345678" }, alice))).toBe("VM_PROVIDER_REQUIRED");
  });
});
