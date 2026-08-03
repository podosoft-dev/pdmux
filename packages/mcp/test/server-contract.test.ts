import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { PDMUX_TOOL_NAMES, createPdmuxMcpServer, type PdmuxHostGateway } from "../src/index.js";

/**
 * What a client actually sees.
 *
 * The surface is the security boundary here — not the handlers. A tool that took
 * a host id, or a tool that created hosts, would widen what a leaked key reaches
 * no matter how carefully the gateway behind it was written. So these run against
 * the real server over a real transport, and assert on the shapes a client is
 * offered rather than on our intentions.
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
  const server = createPdmuxMcpServer(gateway, { hostLabel: "build-01", canRun });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, gateway };
}

describe("[TC-PDMCP-070] the tool surface a client is offered", () => {
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];

  beforeAll(async () => {
    const { client } = await connect(true);
    tools = (await client.listTools()).tools;
  });

  it("[TC-PDMCP-070] offers exactly the pdmux tools, and nothing that creates a host", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...PDMUX_TOOL_NAMES].sort());
    // Not filtered at call time — never registered. A key that could register more
    // machines would be a credential that grows its own scope.
    expect(tools.some((tool) => /register|create|add_host/i.test(tool.name))).toBe(false);
  });

  it("[TC-PDMCP-070] takes no host id anywhere, so there is nothing to validate", () => {
    // The key is bound to one host. Making the host a parameter would mean every
    // handler had to re-check it; having no parameter means there is no way to ask.
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
    const server = createPdmuxMcpServer(gateway, { hostLabel: "build-01", canRun: true });
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
