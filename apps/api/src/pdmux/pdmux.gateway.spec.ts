import { describe, expect, it, mock } from "bun:test";
import { AGENT_KEY_HEADER } from "@pdmux/protocol";
import { isVerifyDial, VerifyDialBudget, VERIFY_DIALS_PER_WINDOW } from "../agents/agent-verify";
import { databaseUnavailable } from "../auth/database-outage";
import type { BrowserSocket } from "../terminal/terminal-relay.service";
import { PdmuxGateway, type TerminalAcceptContext } from "./pdmux.gateway";
import type { PdmuxServices } from "./pdmux.services";

function services(overrides: Partial<PdmuxServices>): PdmuxServices {
  return overrides as PdmuxServices;
}

function socket(sendResult = 1) {
  return {
    send: mock((data: string) => {
      void data;
      return sendResult;
    }),
    close: mock(() => undefined),
    terminate: mock(() => undefined),
    ping: mock(() => undefined),
  };
}

describe("PdmuxGateway authorization", () => {
  it("[TC-PDADMIN-051] records every opaque credential and host refusal", async () => {
    const cases = [
      { outcome: { refusal: "unknown" as const, hostId: null }, host: null, statusCode: 401 },
      { outcome: { refusal: "revoked" as const, hostId: "host-1" }, host: null, statusCode: 401 },
      { outcome: { refusal: "expired" as const, hostId: "host-2" }, host: null, statusCode: 401 },
      {
        outcome: { hostId: "host-3", token: { id: "token-3", expiresAt: null } },
        host: null,
        statusCode: 401,
      },
      {
        outcome: { hostId: "host-4", token: { id: "token-4", expiresAt: null } },
        host: { id: "host-4", organizationId: "org-1", enabled: false },
        statusCode: 403,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const record = mock(async () => undefined);
      const gateway = new PdmuxGateway(services({
        agentTokens: {
          resolveOrReason: mock(async () => testCase.outcome),
        } as unknown as PdmuxServices["agentTokens"],
        agentAuthFailures: { record } as unknown as PdmuxServices["agentAuthFailures"],
        hosts: { getById: mock(async () => testCase.host) } as unknown as PdmuxServices["hosts"],
      }));
      const request = new Request("http://localhost/agent/ws", {
        headers: {
          [AGENT_KEY_HEADER]: `pdmux_agent_secret_${index}`,
          "x-forwarded-for": "203.0.113.8, 10.0.0.2",
        },
      });

      await expect(gateway.authorizeAgent(request)).rejects.toMatchObject({ statusCode: testCase.statusCode });
      const expectedReason = "refusal" in testCase.outcome
        ? testCase.outcome.refusal
        : testCase.host === null ? "host_deleted" : "host_disabled";
      const expectedHostId = "refusal" in testCase.outcome
        ? testCase.outcome.hostId
        : testCase.outcome.hostId;
      expect(record).toHaveBeenCalledWith(expectedReason, expectedHostId, "203.0.113.8");
      expect(JSON.stringify(record.mock.calls)).not.toContain(`pdmux_agent_secret_${index}`);
    }
  });

  it("[TC-PDADMIN-051] rejects a missing key before lookup and records its source", async () => {
    const resolveOrReason = mock(async () => ({ refusal: "unknown" as const, hostId: null }));
    const record = mock(async () => undefined);
    const gateway = new PdmuxGateway(services({
      agentTokens: { resolveOrReason } as unknown as PdmuxServices["agentTokens"],
      agentAuthFailures: { record } as unknown as PdmuxServices["agentAuthFailures"],
    }));

    const request = new Request("http://localhost/agent/ws", {
      headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" },
    });
    await expect(gateway.authorizeAgent(request)).rejects.toMatchObject({ statusCode: 401 });
    expect(resolveOrReason).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("missing_key", null, "203.0.113.8");
  });

  it("[TC-PDAGENT-065] keeps verification dials out of the live registry", async () => {
    expect(isVerifyDial(new URLSearchParams("mode=verify"))).toBe(true);
    expect(isVerifyDial(new URLSearchParams("mode=Verify"))).toBe(false);
    expect(isVerifyDial(new URLSearchParams("mode=verifying"))).toBe(false);

    const register = mock(() => undefined);
    const markUsed = mock(async () => undefined);
    const ackAllRepos = mock(async () => 0);
    const gateway = new PdmuxGateway(services({
      agentTokens: { markUsed } as unknown as PdmuxServices["agentTokens"],
      agentRegistry: { register } as unknown as PdmuxServices["agentRegistry"],
      agentConfig: { build: mock(async () => ({ heartbeatIntervalSec: 15 })) } as unknown as PdmuxServices["agentConfig"],
      agentAck: { ackAllRepos } as unknown as PdmuxServices["agentAck"],
    }));
    const ws = socket();

    await gateway.openAgent(ws, {
      hostId: "host-1",
      organizationId: "org-1",
      tokenId: "token-1",
      tokenExpiresAt: null,
      verify: true,
    });

    expect(register).not.toHaveBeenCalled();
    expect(ackAllRepos).not.toHaveBeenCalled();
    expect(markUsed).toHaveBeenCalledWith("token-1");
    expect(ws.close).toHaveBeenCalledWith(1000, "verify complete");
    gateway.agentMessage(ws, { type: "hello" });

    const budget = new VerifyDialBudget();
    const now = Date.now();
    for (let attempt = 0; attempt < VERIFY_DIALS_PER_WINDOW; attempt += 1) {
      expect(budget.allow("host-1", now)).toBe(true);
    }
    expect(budget.allow("host-1", now)).toBe(false);
    expect(budget.allow("host-2", now)).toBe(true);
  });

  it("binds an accepted agent socket to its host and sends the welcome frame", async () => {
    const host = { id: "host-1", organizationId: "org-1", enabled: true };
    const register = mock(() => undefined);
    const markUsed = mock(async () => undefined);
    const ackAllRepos = mock(async () => 0);
    const gateway = new PdmuxGateway(services({
      agentTokens: {
        resolveOrReason: mock(async () => ({
          hostId: host.id,
          token: { id: "token-1", expiresAt: null },
        })),
        markUsed,
      } as unknown as PdmuxServices["agentTokens"],
      agentAuthFailures: { record: mock(async () => undefined) } as unknown as PdmuxServices["agentAuthFailures"],
      hosts: { getById: mock(async () => host) } as unknown as PdmuxServices["hosts"],
      agentRegistry: { register } as unknown as PdmuxServices["agentRegistry"],
      agentConfig: { build: mock(async () => ({ heartbeatIntervalSec: 15 })) } as unknown as PdmuxServices["agentConfig"],
      agentAck: { ackAllRepos } as unknown as PdmuxServices["agentAck"],
    }));
    const accepted = await gateway.authorizeAgent(new Request("http://localhost/agent/ws", {
      headers: { [AGENT_KEY_HEADER]: "pdmux_agent_key" },
    }));
    const ws = socket();
    await gateway.openAgent(ws, accepted);

    expect(register).toHaveBeenCalledWith("host-1", ws, "token-1");
    expect(markUsed).toHaveBeenCalledWith("token-1");
    expect(ackAllRepos).toHaveBeenCalledWith("host-1");
    expect(JSON.parse(String(ws.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "welcome",
      hostId: "host-1",
      config: { heartbeatIntervalSec: 15 },
    });
  });
});

describe("[TC-PDHOST-033] PdmuxGateway while pdmux's database is unavailable", () => {
  it("keeps a connected agent and the process alive when its frames cannot be stored", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    // Bun's process type declares only its own `off` event; the emitter's is the general one.
    const emitter: NodeJS.EventEmitter = process;
    emitter.on("unhandledRejection", listener);
    try {
      const failures = [databaseUnavailable(), new Error("relation \"hosts\" does not exist")];
      const handle = mock(async (): Promise<never> => { throw failures.shift(); });
      const gateway = new PdmuxGateway(services({
        agentTokens: { markUsed: mock(async () => undefined) } as unknown as PdmuxServices["agentTokens"],
        agentRegistry: { register: mock(() => undefined) } as unknown as PdmuxServices["agentRegistry"],
        agentConfig: { build: mock(async () => ({ heartbeatIntervalSec: 15 })) } as unknown as PdmuxServices["agentConfig"],
        agentAck: { ackAllRepos: mock(async () => 0) } as unknown as PdmuxServices["agentAck"],
        agentIngest: { handle } as unknown as PdmuxServices["agentIngest"],
      }));
      const ws = socket();
      await gateway.openAgent(ws, { hostId: "host-1", organizationId: "org-1", tokenId: "token-1", tokenExpiresAt: null, verify: false });

      gateway.agentMessage(ws, { type: "heartbeat" });
      gateway.agentMessage(ws, { type: "heartbeat" });
      await Bun.sleep(20);

      expect(handle).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
      expect(ws.close).not.toHaveBeenCalled();
    } finally {
      emitter.off("unhandledRejection", listener);
    }
  });

  it("closes an agent socket it could not open instead of leaving it without a welcome", async () => {
    const gateway = new PdmuxGateway(services({
      agentTokens: { markUsed: mock(async (): Promise<never> => { throw databaseUnavailable(); }) } as unknown as PdmuxServices["agentTokens"],
      agentRegistry: { register: mock(() => undefined) } as unknown as PdmuxServices["agentRegistry"],
    }));
    const ws = socket();

    await gateway.openAgent(ws, { hostId: "host-1", organizationId: "org-1", tokenId: "token-1", tokenExpiresAt: null, verify: false });

    expect(ws.close).toHaveBeenCalledWith(1011, "config unavailable");
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("PdmuxGateway terminal backpressure", () => {
  it("maps Bun send backpressure to the existing relay contract until drain", () => {
    let relaySocket: BrowserSocket | undefined;
    const openConnection = mock((input: { socket: BrowserSocket }) => {
      relaySocket = input.socket;
      return "connection-1";
    });
    const gateway = new PdmuxGateway(services({
      terminalRelay: { openConnection } as unknown as PdmuxServices["terminalRelay"],
    }));
    const ws = socket(-1);
    const context: TerminalAcceptContext = {
      hostId: "host-1",
      hostLabel: "Host",
      principal: {
        userId: "user-1",
        userName: "User",
        userEmail: "user@example.com",
        scopeId: "personal:user-1",
      },
      bufferBytes: 1024,
    };

    gateway.openTerminal(ws, context);
    relaySocket?.send("output");
    expect(relaySocket?.bufferedAmount).toBe(Number.MAX_SAFE_INTEGER);
    gateway.terminalDrain(ws);
    expect(relaySocket?.bufferedAmount).toBe(0);
  });
});
