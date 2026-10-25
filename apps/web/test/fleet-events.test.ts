import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetEvents } from "../src/lib/dashboard/fleet-events";

class TestDocument extends EventTarget {
  visibilityState = "visible";
}
class TestSource {
  static instances: TestSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TestSource.instances.push(this); }
  close(): void { this.closed = true; }
  send(data: string): void { this.onmessage?.({ data } as MessageEvent<string>); }
}

afterEach((): void => { vi.unstubAllGlobals(); TestSource.instances = []; });

describe("[TC-PDWEB-034] fleet event lifecycle", () => {
  it("refreshes only for recognized invalidations and reconnect readiness", (): void => {
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", TestSource);
    const refresh = vi.fn(async (): Promise<void> => {});
    const events = new FleetEvents(refresh, async (): Promise<void> => {});
    events.start(); events.start();
    expect(TestSource.instances).toHaveLength(1);
    const source = TestSource.instances[0]!;
    expect(source.url).toBe("/api/fleet/events");
    source.send('{"type":"ready"}');
    source.send('{"type":"hosts.changed"}');
    source.send('{"type":"heartbeat"}'); source.send("invalid"); source.send("null");
    expect(refresh).toHaveBeenCalledTimes(2);
    events.stop();
    source.send('{"type":"hosts.changed"}');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(source.closed).toBe(true);
  });
  it("releases hidden-page connections and stops listening after unmount", (): void => {
    const document = new TestDocument();
    vi.stubGlobal("document", document);
    vi.stubGlobal("EventSource", TestSource);
    const events = new FleetEvents(async (): Promise<void> => {}, async (): Promise<void> => {});
    events.start();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances[0]?.closed).toBe(true);
    expect(TestSource.instances).toHaveLength(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances).toHaveLength(2);
    events.stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances).toHaveLength(2);
    expect(TestSource.instances[1]?.closed).toBe(true);
  });
});

describe("[TC-PDWEB-038] fleet client after an event bus interruption", () => {
  it("runs the full reload on resync and the host refresh on everything else", (): void => {
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", TestSource);
    const refresh = vi.fn(async (): Promise<void> => {});
    const reload = vi.fn(async (): Promise<void> => {});
    const events = new FleetEvents(refresh, reload);
    events.start();
    const source = TestSource.instances[0]!;
    source.send('{"type":"resync"}');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    source.send('{"type":"hosts.changed"}');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    events.stop();
    source.send('{"type":"resync"}');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

class FailingSource {
  static instances: FailingSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FailingSource.instances.push(this); }
  close(): void { this.closed = true; }
  send(data: string): void { this.onmessage?.({ data } as MessageEvent<string>); }
  fail(): void { this.onerror?.(); }
}

function report(): { alive: ReturnType<typeof vi.fn<() => boolean>>; lost: ReturnType<typeof vi.fn<() => void>>; down: boolean } {
  const state = { down: false } as { down: boolean };
  const alive = vi.fn((): boolean => { const recovered = state.down; state.down = false; return recovered; });
  const lost = vi.fn((): void => { state.down = true; });
  return Object.assign(state, { alive, lost });
}

describe("[TC-PDWEB-044] a failed event stream is dialled again with backoff", () => {
  afterEach((): void => { vi.useRealTimers(); FailingSource.instances = []; });

  it("closes the source on an error, reports the loss and reconnects without waiting for the tab to be shown again", (): void => {
    vi.useFakeTimers();
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", FailingSource);
    const refresh = vi.fn(async (): Promise<void> => {});
    const connection = report();
    const events = new FleetEvents(refresh, async (): Promise<void> => {}, { connection, random: () => 1, minBackoffMs: 1_000 });
    events.start();
    const first = FailingSource.instances[0]!;
    first.send('{"type":"ready"}');
    expect(refresh).toHaveBeenCalledTimes(1);

    first.fail();
    expect(first.closed).toBe(true);
    expect(connection.lost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(FailingSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FailingSource.instances).toHaveLength(2);

    // The second attempt fails too: the delay doubles.
    FailingSource.instances[1]!.fail();
    vi.advanceTimersByTime(1_999);
    expect(FailingSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FailingSource.instances).toHaveLength(3);

    // It answers: the recovery reads everything, so `ready` does not also refresh.
    FailingSource.instances[2]!.send('{"type":"ready"}');
    expect(connection.alive).toHaveBeenLastCalledWith();
    expect(refresh).toHaveBeenCalledTimes(1);
    events.stop();
    vi.advanceTimersByTime(60_000);
    expect(FailingSource.instances).toHaveLength(3);
  });
});

describe("[TC-PDWEB-045] a silent event stream counts as lost", () => {
  afterEach((): void => { vi.useRealTimers(); FailingSource.instances = []; });

  it("keeps a stream that sends heartbeats and replaces one that stops", (): void => {
    vi.useFakeTimers();
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", FailingSource);
    const connection = report();
    const events = new FleetEvents(async (): Promise<void> => {}, async (): Promise<void> => {}, {
      connection, silenceMs: 15_000, random: () => 1, minBackoffMs: 1_000, now: () => Date.now(),
    });
    events.start();
    const source = FailingSource.instances[0]!;
    for (let beat = 0; beat < 6; beat += 1) {
      vi.advanceTimersByTime(5_000);
      source.send('{"type":"heartbeat"}');
    }
    expect(source.closed).toBe(false);
    expect(connection.lost).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20_000);
    expect(source.closed).toBe(true);
    expect(connection.lost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(FailingSource.instances).toHaveLength(2);
    events.stop();
  });
});
