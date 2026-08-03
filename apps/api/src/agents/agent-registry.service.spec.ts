import { beforeEach, describe, expect, it } from "@jest/globals";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";

class RecordingSocket implements AgentSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

describe("AgentRegistryService", () => {
  let registry: AgentRegistryService;

  beforeEach(() => {
    registry = new AgentRegistryService();
  });

  it("[TC-PDAGENT-057] keeps one socket per host and closes the one it replaces", () => {
    const first = new RecordingSocket();
    const second = new RecordingSocket();

    registry.register("host-1", first, "token-1");
    expect(registry.isConnected("host-1")).toBe(true);

    registry.register("host-1", second, "token-1");
    expect(first.closed?.code).toBe(4000);
    expect(registry.connectedHostIds()).toEqual(["host-1"]);

    // A late close from the replaced socket must not evict the live one.
    registry.unregister("host-1", first);
    expect(registry.isConnected("host-1")).toBe(true);

    registry.unregister("host-1", second);
    expect(registry.isConnected("host-1")).toBe(false);
  });

  it("[TC-PDAGENT-057] reports delivery instead of queueing for an absent agent", () => {
    const socket = new RecordingSocket();
    registry.register("host-1", socket, "token-1");

    expect(registry.sendToHost("host-1", { type: "collect", what: "repos" })).toBe(true);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "collect", what: "repos" });

    expect(registry.sendToHost("host-2", { type: "collect", what: "heartbeat" })).toBe(false);

    // A socket that throws on send is reported as undelivered, not as an exception.
    socket.close();
    expect(registry.sendToHost("host-1", { type: "ping", ts: 1 })).toBe(false);
  });

  it("[TC-PDAGENT-057] fans terminal frames out and survives a broken subscriber", () => {
    const seen: string[] = [];
    registry.onTerminalFrame(() => {
      throw new Error("subscriber exploded");
    });
    const unsubscribe = registry.onTerminalFrame((hostId, frame) => seen.push(`${hostId}:${frame.type}`));

    registry.emitTerminalFrame("host-1", { type: "output", termId: "t1", data: "x", dropped: 0 });
    expect(seen).toEqual(["host-1:output"]);

    unsubscribe();
    registry.emitTerminalFrame("host-1", { type: "exit", termId: "t1", code: 0 });
    expect(seen).toEqual(["host-1:output"]);
  });
});
