import { describe, expect, it, mock } from "bun:test";
import "reflect-metadata";

import { AppException } from "../common/app-exception";
import { ApiFleetGateway } from "./fleet-gateway";
import type { McpUserIdentity } from "./user-mcp-keys.service";

/**
 * Where the scope guarantee lives now.
 *
 * ⚠ THIS FILE IS THE OTHER HALF OF A DELETED ASSERTION. `packages/mcp` used to
 * assert that no tool's schema mentioned `hostId` — with no such parameter, a caller
 * simply could not name another machine, and the guarantee was structural. Fleet
 * mode takes a host id, so the guarantee became a runtime one:
 * `HostsService.get(scope, id)` refuses an id outside the token's scope.
 *
 * That check cannot be tested in `packages/mcp` — it has no database and no services
 * — so it is tested here, beside the call. The contract test says as much in its own
 * comment, and the two must be read together.
 *
 * ⚠ AND THE REFUSAL IS 404, NOT 403. 403 confirms the id exists, which is a fact the
 * caller was not entitled to. `HostsService.get` already answers that way; these
 * tests exist so nobody "improves" it into a more informative error.
 */

const SCOPE = "org-a";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

const IDENTITY: McpUserIdentity = {
  keyId: "tok-1",
  userId: "user-1",
  organizationId: SCOPE,
  tier: "admin",
  effectiveTier: "admin",
};

/**
 * A hosts service that answers only for one scope, exactly as the real one does:
 * a host in another scope is not "forbidden", it is not found.
 */
function fakeHosts() {
  const notFound = () => new AppException("HOST_NOT_FOUND", "Host not found", 404);
  const row = (id: string) => ({
    id,
    label: "build-01",
    address: null,
    agentAddress: null,
    description: null,
    tags: [],
    enabled: true,
    agentVersion: "0.1.7",
    os: "linux",
    arch: "amd64",
    capabilities: ["exec"],
    lastSeenAt: null,
    lastUpdate: null,
  });
  return {
    get: mock(async (scope: string, id: string) => {
      if (scope !== SCOPE || id !== MINE) throw notFound();
      return row(id);
    }),
    list: mock(async (scope: string) => (scope === SCOPE ? [{ ...row(MINE), online: true, agentVersionState: "current", sessions: [], usage: [] }] : [])),
    createWithEnrollment: mock(async () => ({
      ...row(MINE),
      enrollment: { id: "e1", code: "pdmxe_AAAAA-BBBBB-CCCCC-DDDDD", expiresAt: new Date().toISOString(), expiresInSec: 900 },
    })),
    update: mock(async (scope: string, id: string) => {
      if (scope !== SCOPE || id !== MINE) throw notFound();
      return row(id);
    }),
    remove: mock(async (scope: string, id: string) => {
      if (scope !== SCOPE || id !== MINE) throw notFound();
      return { id, label: "build-01" };
    }),
  };
}

function context(identity: McpUserIdentity = IDENTITY) {
  const hosts = fakeHosts();
  const scoped = <T>(name: string, value: T) =>
    mock(async (scope: string, id: string) => {
      // Every sibling service takes the scope too; refusing here is what proves the
      // gateway passed it rather than reaching past it.
      if (scope !== SCOPE || id !== MINE) throw new AppException("HOST_NOT_FOUND", `${name} not found`, 404);
      return value;
    });
  const audit = mock();
  const gateway = new ApiFleetGateway(identity, {
    hosts: hosts as never,
    hostServices: { list: scoped("services", []) } as never,
    metrics: { series: mock(async () => ({ points: [] })) } as never,
    git: { listRepos: scoped("repos", []) } as never,
    // ⚠ THE FAKES REFUSE A FOREIGN SCOPE TOO, because the real services do. A fake
    // that answered for any scope would let the gateway reach past `hosts.get` and
    // the test would still pass — which is the exact bug these tests exist to catch.
    enrollments: {
      create: scoped("enrollment", { id: "e1", code: "pdmxe_AAAAA-BBBBB-CCCCC-DDDDD", expiresAt: new Date().toISOString(), expiresInSec: 900 }),
      current: scoped("enrollment", null),
    } as never,
    exec: { run: scoped("exec", { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, code: null, message: "" }) } as never,
    updates: {
      updateHost: scoped("update", { commandId: "c1" }),
      updateFleet: mock(async (scope: string) => {
        if (scope !== SCOPE) throw new AppException("HOST_NOT_FOUND", "not found", 404);
        return { started: 1 };
      }),
    } as never,
    origin: "https://pdmux.example.test",
    scopeLabel: "my fleet",
    audit,
  });
  return { gateway, hosts, audit };
}

/** Every method that names a machine, and what it is called with. */
const NAMED: [string, (g: ApiFleetGateway, hostId: string) => Promise<unknown>][] = [
  ["detail", (g, h) => g.detail(h)],
  ["metrics", (g, h) => g.metrics(h, 3600)],
  ["sessions", (g, h) => g.sessions(h)],
  ["services", (g, h) => g.services(h)],
  ["usage", (g, h) => g.usage(h)],
  ["repos", (g, h) => g.repos(h)],
  ["updateHost", (g, h) => g.updateHost(h, { label: "renamed" })],
  ["enrollment", (g, h) => g.enrollment(h)],
  ["enrollmentPlan", (g, h) => g.enrollmentPlan(h)],
  ["enrollmentStatus", (g, h) => g.enrollmentStatus(h)],
  ["updateAgent", (g, h) => g.updateAgent(h, { force: false })],
  ["updateAgentPlan", (g, h) => g.updateAgentPlan(h, {})],
  ["agentUpdateStatus", (g, h) => g.agentUpdateStatus(h)],
  ["updateFleetPlan", (g, h) => g.updateFleetPlan([h], "0.1.8")],
  ["deleteHostPlan", (g, h) => g.deleteHostPlan(h)],
  ["deleteHost", (g, h) => g.deleteHost(h)],
  ["run", (g, h) => g.run(h, { command: "id", args: [] })],
];

describe("[TC-PDMCP-055] a fleet token reaches only its own scope", () => {
  it.each(NAMED)("%s refuses a host in another scope", async (_name, call) => {
    const { gateway } = context();
    await expect(call(gateway, THEIRS)).rejects.toBeInstanceOf(AppException);
  });

  it.each(NAMED)("%s answers for a host in its own scope", async (_name, call) => {
    const { gateway } = context();
    await call(gateway, MINE);
  });

  /**
   * ⚠ 404, NOT 403 — and the distinction is the whole reason to assert on the code
   * rather than merely on "it threw". A 403 tells the caller the id is real.
   */
  it("says not-found rather than forbidden", async () => {
    const { gateway } = context();
    await expect(gateway.detail(THEIRS)).rejects.toMatchObject({ code: "HOST_NOT_FOUND" });
  });
});

describe("[TC-PDMCP-055] a dry run cannot change anything", () => {
  it("plans a deletion without calling remove", async () => {
    const { gateway, hosts } = context();

    const plan = await gateway.deleteHostPlan(MINE);

    expect(plan.reversible).toBe(false);
    expect(plan.willDestroy.length).toBeGreaterThan(1);
    // The mutator is a different method, which is what makes this assertable at all.
    expect(hosts.remove).not.toHaveBeenCalled();
  });

  it("names the live connection only when there is one", async () => {
    const { gateway } = context();
    const plan = await gateway.deleteHostPlan(MINE);
    // The fake reports the host online, so the operator is told the machine is
    // reporting right now — the fact most likely to change their mind.
    expect(JSON.stringify(plan.willDestroy)).toMatch(/connected RIGHT NOW/i);
  });

  it("refuses to plan a fleet update that reaches outside the scope", async () => {
    const { gateway } = context();
    // A count that included hosts the caller cannot see would be a lie in the very
    // list the person is being asked to approve.
    await expect(gateway.updateFleetPlan([MINE, THEIRS], "0.1.8")).rejects.toBeInstanceOf(AppException);
  });
});

describe("[TC-PDMCP-055] what the audit trail records", () => {
  it("records a mutation with the token and tier, and no arguments from the command line", async () => {
    const { gateway, audit } = context();

    await gateway.run(MINE, { command: "psql", args: ["--password=hunter2"] });

    expect(audit).toHaveBeenCalledTimes(1);
    const entry = JSON.stringify((audit.mock.calls[0] as unknown[])[0]);
    expect(entry).toContain("run_command");
    expect(entry).toContain(MINE);
    // ⚠ THE ARGUMENTS ARE NOT IN IT. A command line is the likeliest place on this
    // surface for a secret, and an audit table that records secrets is a second
    // place they leak from. The command NAME is kept, because "which tool ran" is
    // the point of the entry.
    expect(entry).toContain("psql");
    expect(entry).not.toContain("hunter2");
    // Who did it is added by `recordToolAudit` in the controller, which is the layer
    // that holds the identity — this one only says what happened to what.
  });

  /**
   * ⚠ THE ATTEMPT IS THE ENTRY WORTH HAVING. Local verification found this missing:
   * the plan left no trace, so an abandoned deletion was indistinguishable from one
   * that never happened. `confirmed` is what separates "a person agreed" from "a
   * token did it".
   */
  it("records the dry run as well as the deletion, and tells them apart", async () => {
    const { gateway, audit } = context();

    await gateway.deleteHostPlan(MINE);
    await gateway.deleteHost(MINE);

    const entries = audit.mock.calls.map((call) => (call as unknown[])[0] as { metadata?: Record<string, unknown> });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.metadata).toMatchObject({ dryRun: true, confirmed: false });
    expect(entries[1]?.metadata).toMatchObject({ dryRun: false, confirmed: true });
  });

  /**
   * ⚠ A REFUSED ATTEMPT MUST NOT WRITE A FOREIGN HOST ID INTO THIS CALLER'S TRAIL.
   * The plan used to audit what was ASKED FOR, before the scope check — so naming a
   * machine in somebody else's fleet put its id in a record this person can read,
   * which is the fact they were just refused.
   */
  it("does not record a fleet plan that named a host outside the scope", async () => {
    const { gateway, audit } = context();

    await expect(gateway.updateFleetPlan([MINE, THEIRS], "0.1.8")).rejects.toBeInstanceOf(AppException);

    expect(audit).not.toHaveBeenCalled();
  });

  it("counts only the hosts it could actually reach", async () => {
    const { gateway, audit } = context();

    await gateway.updateFleetPlan([MINE], "0.1.8");

    expect((audit.mock.calls[0] as unknown[])[0]).toMatchObject({
      metadata: { dryRun: true, confirmed: false, hosts: 1 },
    });
  });

  it("does not record a read", async () => {
    const { gateway, audit } = context();
    await gateway.detail(MINE);
    await gateway.listHosts({});
    // Reads outnumber mutations by orders of magnitude while an install finishes;
    // logging them buries what the table exists for.
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("[TC-PDMCP-055] the effective tier is what gates, not the granted one", () => {
  it("refuses run_command for a token whose owner has been demoted to read", async () => {
    const { gateway } = context({ ...IDENTITY, tier: "admin", effectiveTier: "read" });

    // The row still says admin. Current authority says read, and that is what counts.
    await expect(gateway.run(MINE, { command: "id", args: [] })).rejects.toMatchObject({
      code: "MCP_TIER_INSUFFICIENT",
    });
  });

});
