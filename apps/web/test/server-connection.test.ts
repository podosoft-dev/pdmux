import { ApiError } from "@podosoft/podokit-api-client";
import { describe, expect, it, vi } from "vitest";
import { ServerConnection, TransportLoss, isServerUnreachable } from "../src/lib/dashboard/server-connection.svelte";

function timers() {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let clock = 0;
  let next = 1;
  return {
    now: (): number => clock,
    schedule: (fn: () => void, ms: number): number => { const id = next++; pending.set(id, { at: clock + ms, fn }); return id; },
    cancel: (handle: unknown): void => { pending.delete(handle as number); },
    advance(ms: number): void {
      clock += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > clock) continue;
        pending.delete(id);
        timer.fn();
      }
    },
  };
}

describe("[TC-PDWEB-041] the server connection has three states and recovers once", () => {
  it("goes reconnecting on a loss, offline after the threshold, and online on the next answer", () => {
    const clock = timers();
    const connection = new ServerConnection({ offlineAfterMs: 30_000, ...clock });
    const recovered = vi.fn();
    connection.onRecover(recovered);

    expect(connection.alive()).toBe(false);
    expect(recovered).not.toHaveBeenCalled();

    clock.advance(1_000);
    connection.lost();
    expect(connection.state).toBe("reconnecting");
    expect(connection.lostAt).toBe(1_000);
    clock.advance(10_000);
    connection.lost(); // a repeat within one loss changes nothing
    expect(connection.lostAt).toBe(1_000);
    clock.advance(19_999);
    expect(connection.state).toBe("reconnecting");
    clock.advance(1);
    expect(connection.state).toBe("offline");

    expect(connection.alive()).toBe(true);
    expect(connection.state).toBe("online");
    expect(connection.lostAt).toBeNull();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(connection.alive()).toBe(false);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("does not turn offline after a loss that already ended", () => {
    const clock = timers();
    const connection = new ServerConnection({ offlineAfterMs: 5_000, ...clock });
    connection.lost();
    connection.alive();
    clock.advance(10_000);
    expect(connection.state).toBe("online");
  });
});

describe("[TC-PDWEB-042] only an outage counts as losing the server", () => {
  it("treats a network failure and the gateway statuses as unreachable, and any other answer as reachable", () => {
    expect(isServerUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [502, 503, 504]) expect(isServerUnreachable(new ApiError("X", "x", status))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 500]) expect(isServerUnreachable(new ApiError("X", "x", status))).toBe(false);
  });
});

describe("[TC-PDWEB-043] a host's socket covers its panes only after the grace", () => {
  it("ignores a reconnect that finishes inside the grace and marks one that outlasts it", () => {
    const clock = timers();
    const loss = new TransportLoss({ graceMs: 3_000, ...clock });
    loss.note("h1", "reconnecting");
    clock.advance(2_000);
    loss.note("h1", "open");
    clock.advance(5_000);
    expect(loss.lost.h1).toBeUndefined();

    loss.note("h1", "reconnecting");
    loss.note("h2", "open");
    clock.advance(3_000);
    expect(loss.lost).toEqual({ h1: true });
    loss.note("h1", "reconnecting"); // still away: no second timer, still lost
    expect(loss.lost).toEqual({ h1: true });
    loss.note("h1", "open");
    expect(loss.lost).toEqual({});
  });
});
