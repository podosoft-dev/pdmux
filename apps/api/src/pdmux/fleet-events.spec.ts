import { describe, expect, it } from "bun:test";
import { fleetEventResponse, type FleetEventDependencies } from "./fleet-events";
import type { AuthSession } from "../auth/auth.service";

function fixture(): {
  dependencies: FleetEventDependencies;
  publish: (data: unknown) => void;
  revoke: () => void;
  requests: Request[];
  subscribers: () => number;
} {
  const listeners = new Set<(data: unknown) => void>();
  const requests: Request[] = [];
  let valid = true;
  return {
    requests, revoke: (): void => { valid = false; },
    subscribers: (): number => listeners.size,
    publish: (data: unknown): void => { for (const listener of listeners) listener(data); },
    dependencies: {
      auth: { guard: async (): Promise<void> => {}, requireSession: async (request: Request): Promise<AuthSession> => {
        requests.push(request);
        if (!valid) throw new Error("Session revoked");
        return { user: { id: "owner" }, session: {} };
      } },
      hosts: { listIds: async (scope: string): Promise<string[]> => scope === "personal:owner" ? ["owned"] : [] },
      events: { subscribe: (listener: (data: unknown) => void): (() => void) => {
        listeners.add(listener);
        return (): void => { listeners.delete(listener); };
      } },
    },
  };
}

describe("[TC-PDWEB-033] scoped fleet event stream", () => {
  it("filters foreign hosts, coalesces bursts, and never sends host payloads", async (): Promise<void> => {
    const state = fixture();
    const abort = new AbortController();
    const response = await fleetEventResponse(new Request("http://localhost/fleet/events", { signal: abort.signal }), state.dependencies);
    const reader = response.body!.getReader();
    const decode = new TextDecoder();
    try {
      expect(decode.decode((await reader.read()).value)).toContain('"ready"');
      state.publish({ type: "host.heartbeat", hostId: "foreign", token: "must-not-leak" });
      const next = reader.read();
      expect(await Promise.race([next.then(() => "leak"), Bun.sleep(350).then(() => "quiet")])).toBe("quiet");
      for (let index = 0; index < 500; index += 1) state.publish({ type: "host.heartbeat", hostId: "owned", resource: "private payload" });
      expect(decode.decode((await next).value)).toBe('data: {"type":"hosts.changed"}\n\n');
      const extra = reader.read();
      expect(await Promise.race([extra.then(() => "duplicate"), Bun.sleep(350).then(() => "quiet")])).toBe("quiet");
      abort.abort();
      expect((await extra).done).toBe(true);
      expect(state.subscribers()).toBe(0);
    } finally { abort.abort(); await reader.cancel(); }
  });

  it("revalidates using a fresh Request and closes after revocation", async (): Promise<void> => {
    const state = fixture();
    const request = new Request("http://localhost/fleet/events", { headers: { cookie: "session=fixture" } });
    const response = await fleetEventResponse(request, state.dependencies);
    const reader = response.body!.getReader();
    try {
      await reader.read();
      state.revoke();
      state.publish({ type: "host.update", hostId: "owned" });
      expect((await reader.read()).done).toBe(true);
      expect(state.requests[1]).not.toBe(request);
      expect(state.requests[1]?.headers.get("cookie")).toBe("session=fixture");
      expect(state.subscribers()).toBe(0);
    } finally { await reader.cancel(); }
  });

  it("rejects an unauthenticated connection before subscribing", async (): Promise<void> => {
    const state = fixture();
    state.revoke();
    await expect(fleetEventResponse(new Request("http://localhost/fleet/events"), state.dependencies)).rejects.toThrow("Session revoked");
    expect(state.subscribers()).toBe(0);
  });
});
