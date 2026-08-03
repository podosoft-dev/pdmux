import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PDMUX_FLEET_TOOL_NAMES,
  PDMUX_TOOL_NAMES,
  createPdmuxMcpServer,
  type PdmuxFleetGateway,
  type PdmuxHostGateway,
  type PdmuxTier,
} from "../src/index.js";

/**
 * What a client actually sees.
 *
 * The surface is the security boundary here — not the handlers. So these run
 * against the real server over a real transport, and assert on the shapes a client
 * is offered rather than on our intentions.
 *
 * ⚠ TWO SURFACES NOW, AND ONE OLD ASSERTION HAS MOVED RATHER THAN GONE.
 *
 * Host mode is unchanged and still keeps its structural guarantee: no tool takes a
 * host id, so a leaked host key cannot name another machine whatever the gateway
 * behind it does. That is asserted below, scoped to host mode.
 *
 * Fleet mode names machines explicitly, so the guarantee there is CHECKED rather
 * than structural — `HostsService.get(scope, id)` in the API implementation is what
 * enforces it, and the test for that lives beside it in `fleet-gateway.spec.ts`,
 * because this package has no database to check against. Saying so here is the point:
 * the invariant did not weaken silently, it was moved and re-tested.
 *
 * ⚠ THE `/register|create/` RULE IS GONE ON PURPOSE, REPLACED BY THE ONE IT MEANT.
 * The concern was never the word "create" — it was that a credential must not grow
 * its own scope. Creating a HOST row does not: the row lands inside the scope the
 * token already had. Minting a CREDENTIAL would, and revoking the original would not
 * close it. So the rule is now "no tool mints a credential", asserted for every mode
 * and every tier.
 */

/** Records what was called; every method answers so a tool can be driven. */
function fakeGateway(): PdmuxHostGateway & { calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    calls,
    detail: () =>
      note("detail", {
        id: "h1",
        label: "build-01",
        address: null,
        agentAddress: null,
        description: null,
        tags: [],
        enabled: true,
        online: true,
        agentVersion: "0.1.3",
        os: "linux",
        arch: "amd64",
        capabilities: ["exec"],
        lastSeenAt: null,
      }),
    metrics: (windowSec) => note("metrics", { windowSec }),
    sessions: () => note("sessions", []),
    services: () => note("services", []),
    usage: () => note("usage", []),
    repos: () => note("repos", []),
    enrollment: () =>
      note("enrollment", {
        code: "pdmxe_AAAAA-BBBBB-CCCCC-DDDDD",
        expiresAt: new Date().toISOString(),
        expiresInSec: 900,
        installCommand: "curl -fsSL https://example.test/install.sh | sh -s -- --code pdmxe_AAAAA-BBBBB-CCCCC-DDDDD",
      }),
    run: (input) => {
      calls.push("run");
      return Promise.resolve({
        exitCode: 0,
        stdout: input.args.join(" "),
        stderr: "",
        truncated: false,
        timedOut: false,
        code: null,
        message: "",
      });
    },
  };
}

async function connect(canRun: boolean) {
  const gateway = fakeGateway();
  const server = createPdmuxMcpServer({ mode: "host", gateway, hostLabel: "build-01", canRun });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, gateway };
}

/**
 * Records `method:hostId` so a test can prove WHICH machine was reached — the thing
 * that matters once a host id is a parameter.
 */
function fakeFleetGateway(): PdmuxFleetGateway & { calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const plan = (retryWith: Record<string, unknown>) => ({
    willDestroy: [{ type: "host", label: "build-01" }],
    reversible: false,
    retryWith: { ...retryWith, confirm: true },
  });
  return {
    calls,
    listHosts: () => note("listHosts", []),
    detail: (hostId) => note(`detail:${hostId}`, { id: hostId, label: "build-01" }),
    metrics: (hostId, windowSec) => note(`metrics:${hostId}`, { windowSec }),
    sessions: (hostId) => note(`sessions:${hostId}`, []),
    services: (hostId) => note(`services:${hostId}`, []),
    usage: (hostId) => note(`usage:${hostId}`, []),
    repos: (hostId) => note(`repos:${hostId}`, []),
    createHost: (input) => note("createHost", { hostId: "h-new", hostLabel: input.label ?? "" }),
    updateHost: (hostId) => note(`updateHost:${hostId}`, { id: hostId }),
    enrollment: (hostId) => note(`enrollment:${hostId}`, { hostId }),
    enrollmentPlan: (hostId) => note(`enrollmentPlan:${hostId}`, plan({ hostId })),
    enrollmentStatus: (hostId) => note(`enrollmentStatus:${hostId}`, {}),
    updateAgent: (hostId) => note(`updateAgent:${hostId}`, {}),
    updateAgentPlan: (hostId) => note(`updateAgentPlan:${hostId}`, plan({ hostId })),
    agentUpdateStatus: (hostId) => note(`agentUpdateStatus:${hostId}`, {}),
    updateFleet: (hostIds) => note(`updateFleet:${hostIds.join(",")}`, {}),
    updateFleetPlan: (hostIds) => note(`updateFleetPlan:${hostIds.join(",")}`, plan({ hostIds })),
    deleteHostPlan: (hostId) => note(`deleteHostPlan:${hostId}`, plan({ hostId })),
    deleteHost: (hostId) => note(`deleteHost:${hostId}`, { id: hostId, label: "build-01" }),
    run: (hostId, input) => {
      calls.push(`run:${hostId}`);
      return Promise.resolve({
        exitCode: 0,
        stdout: input.args.join(" "),
        stderr: "",
        truncated: false,
        timedOut: false,
        code: null,
        message: "",
      });
    },
  } as PdmuxFleetGateway & { calls: string[] };
}

async function connectFleet(tier: PdmuxTier) {
  const gateway = fakeFleetGateway();
  const server = createPdmuxMcpServer({
    mode: "fleet",
    gateway,
    scopeLabel: "my fleet",
    origin: "https://pdmux.example.test",
    tier,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, gateway };
}

/** Parses the JSON a tool returned as text. */
function body(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

const HOST_A = "11111111-1111-4111-8111-111111111111";

describe("[TC-PDMCP-070] the tool surface a client is offered", () => {
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];

  beforeAll(async () => {
    const { client } = await connect(true);
    tools = (await client.listTools()).tools;
  });

  it("[TC-PDMCP-070] offers exactly the pdmux tools, and nothing that creates a host", () => {
    // ⚠ A LITERAL, NOT THE IMPORTED CONSTANT ALONE. Comparing the surface against a
    // constant cannot catch a widening: whoever adds a tool adds it to both sides
    // and the assertion stays green. Writing the list here makes adding one a diff a
    // reviewer sees, which is what the original design wanted.
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "host_detail",
        "host_install_command",
        "host_metrics",
        "host_repos",
        "host_services",
        "host_sessions",
        "host_usage",
        "run_command",
      ].sort(),
    );
    expect([...PDMUX_TOOL_NAMES].sort()).toEqual(tools.map((tool) => tool.name).sort());
    // Host mode registers nothing that creates a host — not filtered at call time,
    // never registered. Fleet mode does, deliberately; see its own describe block.
    expect(tools.some((tool) => /create|add_host/i.test(tool.name))).toBe(false);
  });

  it("[TC-PDMCP-070] takes no host id anywhere, so there is nothing to validate", () => {
    // ⚠ SCOPED TO HOST MODE NOW, AND STILL STRUCTURAL HERE. The key is bound to one
    // host, so making the host a parameter would mean every handler had to re-check
    // it; having no parameter means there is no way to ask. Fleet mode DOES take one
    // — what stops it reaching another scope is `HostsService.get(scope, id)`, and
    // the test for that is `apps/api/src/mcp/fleet-gateway.spec.ts`.
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/hostId|host_id/);
    }
  });

  it("[TC-PDMCP-070] tells the model the argument list is not a shell line", () => {
    const run = tools.find((tool) => tool.name === "run_command");
    expect(run?.description).toMatch(/no shell/i);
    const schema = JSON.stringify(run?.inputSchema);
    // Separate fields, and the arguments are a list — a single string is what
    // would have to reach `sh -c`.
    expect(schema).toContain("command");
    expect(schema).toContain("args");
  });

  it("[TC-PDMCP-070] says installing is not something it does", () => {
    const install = tools.find((tool) => tool.name === "host_install_command");
    // The tool hands back a line for a person to run: installing means a shell on
    // the target machine, and that belongs to whoever is sitting at it.
    expect(install?.description).toMatch(/does NOT run|not run anything/i);
  });
});

describe("[TC-PDMCP-071] a read-only key keeps the surface and loses the power", () => {
  it("[TC-PDMCP-071] still lists run_command, and refuses it with a code", async () => {
    const { client, gateway } = await connect(false);
    // Registered even when refused, so the model reads an answer rather than
    // concluding the tool does not exist and inventing another way.
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("run_command");

    const result = await client.callTool({ name: "run_command", arguments: { command: "id", args: [] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("MCP_KEY_READ_ONLY");
    // And it never reached the host.
    expect(gateway.calls).not.toContain("run");
  });

  it("[TC-PDMCP-071] leaves reading alone", async () => {
    const { client, gateway } = await connect(false);
    const result = await client.callTool({ name: "host_detail", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(gateway.calls).toContain("detail");
  });
});

describe("[TC-PDMCP-072] a failure is returned to the model, not thrown at the transport", () => {
  it("[TC-PDMCP-072] carries the stable code so the model can correct itself", async () => {
    const gateway = fakeGateway();
    gateway.run = () => Promise.reject(Object.assign(new Error("too old"), { code: "HOST_EXEC_UNSUPPORTED" }));
    const server = createPdmuxMcpServer({ mode: "host", gateway, hostLabel: "build-01", canRun: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "run_command", arguments: { command: "git", args: ["status"] } });
    expect(result.isError).toBe(true);
    // A transport error would just be "the call failed"; this is something a model
    // can act on ("ask them to update the agent").
    expect(JSON.stringify(result.content)).toContain("HOST_EXEC_UNSUPPORTED");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fleet mode. New surface, new invariants — and one that replaces a deleted rule
 * rather than dropping it.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("[TC-PDMCP-070] the fleet surface grows with the tier and nothing else", () => {
  it.each(["read", "operate", "admin"] as const)("[TC-PDMCP-070] %s sees exactly its own tools", async (tier) => {
    const { client } = await connectFleet(tier);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...PDMUX_FLEET_TOOL_NAMES[tier]].sort());
  });

  it("[TC-PDMCP-070] never advertises a destructive verb to a token that cannot use it", async () => {
    const { client } = await connectFleet("read");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // `run_command` keeps the register-and-refuse shape because a model that cannot
    // see a way to run things invents one. There is no other way to delete a host,
    // so listing it here would only widen what a leaked read token appears to offer.
    expect(names).toContain("run_command");
    expect(names).not.toContain("host_delete");
    expect(names).not.toContain("fleet_agent_update");
  });

  /**
   * ⚠ THE SUCCESSOR TO THE DELETED `/register|create|add_host/` RULE, and the reason
   * deleting it was honest. The invariant was never about the word — it was that a
   * credential must not grow its own scope. It is asserted here for every mode and
   * every tier, which is stronger than the rule it replaces.
   */
  it("[TC-PDMCP-070] mints no credential, in any mode or tier", async () => {
    const surfaces = [
      (await connect(true)).client,
      ...(await Promise.all((["read", "operate", "admin"] as const).map(async (t) => (await connectFleet(t)).client))),
    ];
    for (const client of surfaces) {
      const names = (await client.listTools()).tools.map((tool) => tool.name).join(" ");
      expect(names).not.toMatch(/mcp[_-]?key|token|credential|secret/i);
    }
  });

  it("[TC-PDMCP-070] says out loud that it does not connect to a host", async () => {
    const { client } = await connectFleet("operate");
    const tools = (await client.listTools()).tools;
    const install = tools.find((tool) => tool.name === "host_install_command");
    // The whole ssh story depends on the model believing this sentence.
    expect(install?.description).toMatch(/does NOT run|never connects|your own ssh/i);
    const create = tools.find((tool) => tool.name === "host_create");
    expect(create?.description).toMatch(/never connects|does NOT install/i);
  });
});

describe("[TC-PDMCP-070] a fleet tool reaches the host the caller named, unaided", () => {
  it("[TC-PDMCP-070] passes the id through verbatim and remembers nothing between calls", async () => {
    const { client, gateway } = await connectFleet("admin");
    const other = "22222222-2222-4222-8222-222222222222";

    await client.callTool({ name: "host_detail", arguments: { hostId: HOST_A } });
    await client.callTool({ name: "host_detail", arguments: { hostId: other } });

    // No default, no substitution, no memory of the previous call.
    expect(gateway.calls).toEqual([`detail:${HOST_A}`, `detail:${other}`]);
  });
});

describe("[TC-PDMCP-071] a destructive tool describes before it acts", () => {
  it("[TC-PDMCP-071] answers without confirm by planning, and never calls the mutator", async () => {
    const { client, gateway } = await connectFleet("admin");

    const result = await client.callTool({ name: "host_delete", arguments: { hostId: HOST_A } });

    // ⚠ NOT an error. It is the answer to "what would happen", and `isError` makes a
    // model retry differently or give up instead of asking the person.
    expect(result.isError).toBeFalsy();
    const parsed = body(result);
    expect(parsed.pdmux).toBe("dry-run");
    expect(parsed.confirmed).toBe(false);
    expect(Array.isArray(parsed.willDestroy) && (parsed.willDestroy as unknown[]).length).toBeGreaterThan(0);
    // ⚠ THE ASSERTION THAT KEEPS plan() AND act() SEPARATE. With one method behind a
    // flag there would be nothing here to check, and a refactor folding them together
    // would pass.
    expect(gateway.calls).toContain(`deleteHostPlan:${HOST_A}`);
    expect(gateway.calls).not.toContain(`deleteHost:${HOST_A}`);
  });

  it("[TC-PDMCP-071] round-trips its own retryWith into the confirmed path", async () => {
    const { client, gateway } = await connectFleet("admin");
    const dry = body(await client.callTool({ name: "host_delete", arguments: { hostId: HOST_A } }));

    // Feeding back exactly what the model was told to send. Without this the
    // mechanism is decoration: a model could confirm a different call than the one
    // it showed the user.
    const done = body(await client.callTool({ name: "host_delete", arguments: dry.retryWith as Record<string, unknown> }));

    expect(done.pdmux).toBe("done");
    expect(done.confirmed).toBe(true);
    expect(gateway.calls).toContain(`deleteHost:${HOST_A}`);
  });

  it("[TC-PDMCP-071] leaves the safe agent update ungated", async () => {
    const { client, gateway } = await connectFleet("operate");
    const result = await client.callTool({ name: "host_agent_update", arguments: { hostId: HOST_A } });

    // The plain path is one machine, and the agent restores itself if the new binary
    // cannot connect. A confirmation on every call is a rubber stamp the model always
    // passes, which teaches it to pass the ones that matter too.
    //
    // It is also NOT wrapped in the confirm envelope — the safe path returns what the
    // server said, so the model reads the real answer rather than `{pdmux: "done"}`.
    expect(result.isError).toBeFalsy();
    expect(body(result).pdmux).toBeUndefined();
    expect(gateway.calls).toContain(`updateAgent:${HOST_A}`);
    expect(gateway.calls).not.toContain(`updateAgentPlan:${HOST_A}`);
  });

  it("[TC-PDMCP-071] refuses a forced downgrade below admin", async () => {
    const { client, gateway } = await connectFleet("operate");
    const result = await client.callTool({
      name: "host_agent_update",
      arguments: { hostId: HOST_A, force: true, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("MCP_TIER_INSUFFICIENT");
    expect(gateway.calls).not.toContain(`updateAgent:${HOST_A}`);
  });
});

describe("[TC-PDMCP-072] a destructive tool fails with a code like every other tool", () => {
  /**
   * ⚠ THE SDK CATCHES A THROWN HANDLER ERROR AND KEEPS ONLY THE MESSAGE. Every read
   * tool goes through `call()`, which prefixes the stable code; the destructive ones
   * return a `ToolResult` directly and so bypassed it, answering "Host not found"
   * where everything else answers "HOST_NOT_FOUND: Host not found". A model that
   * branches on the code — which is what this package tells it to do — would have had
   * nothing to branch on exactly where the stakes are highest.
   */
  it("[TC-PDMCP-072] carries the code when the plan itself is refused", async () => {
    const gateway = fakeFleetGateway();
    gateway.deleteHostPlan = () =>
      Promise.reject(Object.assign(new Error("Host not found"), { code: "HOST_NOT_FOUND" }));
    const server = createPdmuxMcpServer({
      mode: "fleet",
      gateway,
      scopeLabel: "my fleet",
      origin: "https://pdmux.example.test",
      tier: "admin",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "host_delete", arguments: { hostId: HOST_A } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("HOST_NOT_FOUND");
  });
});

describe("[TC-PDMCP-071] asking for more is returned, never thrown", () => {
  it("[TC-PDMCP-071] answers an empty host_create with what it needs", async () => {
    const { client, gateway } = await connectFleet("operate");

    const result = await client.callTool({ name: "host_create", arguments: {} });

    // ⚠ A TRANSPORT ERROR WOULD BREAK THIS PACKAGE'S OWN RULE: "failures are
    // RETURNED, not thrown, so a model can correct the call itself". A zod-required
    // property produces exactly that error, which is why the schema declares none.
    expect(result.isError).toBeFalsy();
    const parsed = body(result);
    expect(parsed.pdmux).toBe("needs-input");
    expect(JSON.stringify(parsed.needs)).toContain("label");
    // And the address warning travels with it, because a model that has not read the
    // skill will otherwise ssh to a field pdmux never connects to.
    expect(JSON.stringify(parsed.needs)).toMatch(/never connects/i);
    expect(gateway.calls).not.toContain("createHost");
  });

  it("[TC-PDMCP-071] declares no required properties on the clarifying tool", async () => {
    const { client } = await connectFleet("operate");
    const create = (await client.listTools()).tools.find((tool) => tool.name === "host_create");
    const required = (create?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    expect(required).toEqual([]);
  });
});

describe("[TC-PDMCP-070] pdmux_whoami carries what the tier hides", () => {
  /**
   * ⚠ THE COUNTERWEIGHT TO NOT REGISTERING MUTATING TOOLS BELOW THEIR TIER. The rule
   * this package already had — register `run_command` even when refused, so a model
   * reads an answer instead of inventing a workaround — is kept here for everything
   * else. If somebody drops this, a read-only token silently looks like the whole
   * product.
   */
  it("[TC-PDMCP-070] names the tools a weaker token is missing, and what each needs", async () => {
    const { client, gateway } = await connectFleet("read");

    const result = await client.callTool({ name: "pdmux_whoami", arguments: {} });
    const who = body(result) as {
      tier: string;
      unavailableTools: { name: string; needsTier: string }[];
      notes: string[];
    };

    expect(who.tier).toBe("read");
    expect(who.unavailableTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["host_create", "host_delete", "fleet_agent_update"]),
    );
    expect(who.unavailableTools.find((tool) => tool.name === "host_delete")?.needsTier).toBe("admin");
    expect(who.unavailableTools.find((tool) => tool.name === "host_create")?.needsTier).toBe("operate");
    // The ssh rule is first because it is the one that decides behaviour.
    expect(who.notes[0]).toMatch(/never connects|no ssh credentials/i);
    // ⚠ It is built by the SERVER, not fetched — the gateway does not know the tool
    // table, so the API package never needs that value at runtime.
    expect(gateway.calls).toEqual([]);
  });
});
