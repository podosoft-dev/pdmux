import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStreamClient, type StreamMessage } from "./events";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  get topics(): string | null {
    return new URL(this.url, "http://localhost").searchParams.get("topics");
  }

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(topic: string, data: unknown, lastEventId = ""): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ topic, data }), lastEventId }));
  }

  emitResync(): void {
    this.dispatchEvent(new MessageEvent("resync", { data: "{}" }));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

function latest(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

function recorder(): { handler: (message: StreamMessage) => void; messages: StreamMessage[] } {
  const messages: StreamMessage[] = [];
  return { handler: (message) => messages.push(message), messages };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EventStreamClient", () => {
  it("shares one EventSource and routes messages by topic", () => {
    const client = new EventStreamClient();
    const orders = recorder();
    const jobs = recorder();
    client.subscribe("orders", orders.handler);
    client.subscribe("job-progress", jobs.handler);
    vi.runOnlyPendingTimers();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url.startsWith("/api/events/stream?")).toBe(true);
    expect(latest().topics).toBe("job-progress,orders");

    latest().emitOpen();
    latest().emitMessage("orders", { id: 1 }, "7");
    latest().emitMessage("unknown", "ignored");
    latest().dispatchEvent(new MessageEvent("message", { data: "not json" }));

    expect(orders.messages).toEqual([{ resync: false, topic: "orders", id: "7", data: { id: 1 } }]);
    expect(jobs.messages).toEqual([]);
  });

  it("keeps the stream across a same-tick resubscribe and closes after the last one leaves", () => {
    const client = new EventStreamClient();
    const first = client.subscribe("orders", () => undefined);
    vi.runOnlyPendingTimers();
    const source = latest();

    first();
    const second = client.subscribe("orders", () => undefined);
    vi.runOnlyPendingTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);

    second();
    second();
    vi.runOnlyPendingTimers();
    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects for a new topic and resyncs only subscribers that were already live", () => {
    const client = new EventStreamClient();
    const orders = recorder();
    client.subscribe("orders", orders.handler);
    vi.runOnlyPendingTimers();
    const first = latest();
    first.emitOpen();
    expect(orders.messages).toEqual([]);

    const jobs = recorder();
    client.subscribe("job-progress", jobs.handler);
    vi.runOnlyPendingTimers();
    const second = latest();
    expect(first.closed).toBe(true);
    expect(second.topics).toBe("job-progress,orders");

    first.emitMessage("orders", "stale");
    second.emitOpen();
    expect(orders.messages).toEqual([{ resync: true, topic: "orders" }]);
    expect(jobs.messages).toEqual([]);
  });

  it("does not reconnect when a topic is already on the stream", () => {
    const client = new EventStreamClient();
    client.subscribe("orders", () => undefined);
    vi.runOnlyPendingTimers();
    latest().emitOpen();
    const late = recorder();
    client.subscribe("orders", late.handler);
    vi.runOnlyPendingTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().emitMessage("orders", 1, "1");
    expect(late.messages).toEqual([{ resync: false, topic: "orders", id: "1", data: 1 }]);
  });

  it("passes a server resync to every subscriber", () => {
    const client = new EventStreamClient();
    const orders = recorder();
    const jobs = recorder();
    client.subscribe("orders", orders.handler);
    client.subscribe("job-progress", jobs.handler);
    vi.runOnlyPendingTimers();
    latest().emitOpen();

    latest().emitResync();

    expect(orders.messages).toEqual([{ resync: true, topic: "orders" }]);
    expect(jobs.messages).toEqual([{ resync: true, topic: "job-progress" }]);
  });

  it("reconnects with exponential backoff and resyncs after reconnecting", () => {
    const client = new EventStreamClient({ minBackoffMs: 1_000, maxBackoffMs: 4_000, random: () => 1 });
    const orders = recorder();
    client.subscribe("orders", orders.handler);
    vi.runOnlyPendingTimers();
    latest().emitOpen();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failing = latest();
      failing.emitError();
      expect(failing.closed).toBe(true);
      const count = FakeEventSource.instances.length;
      let waited = 0;
      while (FakeEventSource.instances.length === count) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(orders.messages).toEqual([]);

    latest().emitOpen();
    expect(orders.messages).toEqual([{ resync: true, topic: "orders" }]);

    latest().emitError();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(6);
  });

  it("stops retrying once every subscriber has left", () => {
    const client = new EventStreamClient({ random: () => 0 });
    const unsubscribe = client.subscribe("orders", () => undefined);
    vi.runOnlyPendingTimers();
    latest().emitError();
    unsubscribe();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("isolates a failing subscriber from the others", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new EventStreamClient();
    const healthy = recorder();
    client.subscribe("orders", () => {
      throw new Error("boom");
    });
    client.subscribe("orders", healthy.handler);
    vi.runOnlyPendingTimers();
    latest().emitMessage("orders", 1, "1");
    expect(healthy.messages).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid topics and does nothing without EventSource", () => {
    const client = new EventStreamClient();
    expect(() => client.subscribe("a,b", () => undefined)).toThrow("Invalid event topic");
    vi.unstubAllGlobals();
    vi.stubGlobal("EventSource", undefined);
    const unsubscribe = client.subscribe("orders", () => undefined);
    vi.runOnlyPendingTimers();
    unsubscribe();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
