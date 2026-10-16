import type { RedisClient } from "bun";
import { describe, expect, it } from "bun:test";
import { RedisCommandTimeoutError } from "../config/redis.connection";
import { RedisEventBus } from "./redis-event.bus";

type Listener = (message: string, channel: string) => void;

/**
 * One Redis server shared by fake clients: it can go down, and it drops every
 * connection when it does. While paused it keeps connections open and answers nothing.
 */
class FakeRedis {
  up = true;
  paused = false;
  readonly clients: FakeClient[] = [];

  client(): RedisClient {
    const client = new FakeClient(this);
    this.clients.push(client);
    return client as unknown as RedisClient;
  }

  stop(): void {
    this.up = false;
    for (const client of this.clients) client.drop();
  }

  deliver(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.clients) {
      if (!client.connected || !client.channels.has(channel)) continue;
      receivers += 1;
      client.listener?.(message, channel);
    }
    return receivers;
  }
}

class FakeClient {
  connected = false;
  onclose: ((error: Error) => void) | null = null;
  readonly channels = new Set<string>();
  listener?: Listener;
  private readonly pending = new Set<(error: Error) => void>();

  constructor(private readonly server: FakeRedis) {}

  /** Never answers while the server is paused; closing the connection fails the command. */
  private answer<T>(value: () => T): Promise<T> {
    if (!this.server.paused) return Promise.resolve(value());
    return new Promise<T>((_resolve, reject) => {
      this.pending.add(reject);
    });
  }

  connect(): Promise<void> {
    if (!this.server.up) {
      this.onclose?.(new Error("Connection closed"));
      return Promise.reject(new Error("Connection closed"));
    }
    this.connected = true;
    return Promise.resolve();
  }

  ping(): Promise<string> {
    return this.connected ? this.answer(() => "PONG") : Promise.reject(new Error("Connection closed"));
  }

  publish(channel: string, message: string): Promise<number> {
    if (!this.connected) {
      return Promise.reject(new Error("Connection is closed and offline queue is disabled"));
    }
    return this.answer(() => this.server.deliver(channel, message));
  }

  subscribe(channel: string, listener: Listener): Promise<number> {
    if (!this.connected) return Promise.reject(new Error("Connection closed"));
    return this.answer(() => {
      this.channels.add(channel);
      this.listener = listener;
      return this.channels.size;
    });
  }

  drop(): void {
    if (!this.connected) return;
    // Bun forgets the server subscription but keeps its listener.
    this.connected = false;
    this.channels.clear();
    this.onclose?.(new Error("Connection closed"));
  }

  close(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const reject of this.pending) reject(new Error("Connection closed"));
    this.pending.clear();
    this.onclose?.(new Error("Connection closed"));
  }
}

function bus(server: FakeRedis): RedisEventBus {
  return new RedisEventBus(
    { EVENTS_REDIS_CHANNEL: "test:events", REDIS_COMMAND_TIMEOUT_MS: "50" },
    () => server.client(),
  );
}

describe("RedisEventBus reconnects", () => {
  it("keeps handlers registered without Redis and delivers once the channel is subscribed", async () => {
    const server = new FakeRedis();
    server.up = false;
    const events = bus(server);
    let interruptions = 0;
    events.onInterruption(() => { interruptions += 1; });
    const received: unknown[] = [];
    await events.subscribe("sse", (event) => { received.push(event); });

    await expect(events.connect()).rejects.toThrow("Connection closed");
    await expect(events.ready()).rejects.toThrow("not subscribed");
    server.up = true;
    await events.connect();
    await events.ready();

    await events.publish("sse", { id: 1 });
    expect(received).toEqual([{ id: 1 }]);
    // Streams opened before the first subscription may have missed events.
    expect(interruptions).toBe(1);
    events.close();
  });

  it("subscribes again after Redis drops the connections and reports one interruption", async () => {
    const server = new FakeRedis();
    const events = bus(server);
    const lost: unknown[] = [];
    events.onLost((reason) => { lost.push(reason); });
    let interruptions = 0;
    events.onInterruption(() => { interruptions += 1; });
    const received: unknown[] = [];
    await events.subscribe("config.changed", (event) => { received.push(event); });
    await events.connect();
    expect(interruptions).toBe(0);

    server.stop();
    expect(lost.length).toBeGreaterThan(0);
    await expect(events.ready()).rejects.toThrow("not subscribed");
    await expect(events.publish("config.changed", { origin: "a" })).rejects.toThrow("offline queue");
    server.up = true;
    await events.connect();

    expect(interruptions).toBe(1);
    await events.publish("config.changed", { origin: "b" });
    expect(received).toEqual([{ origin: "b" }]);
    events.close();
  });

  it("reports no interruption when only the publisher reconnects", async () => {
    const server = new FakeRedis();
    const events = bus(server);
    let interruptions = 0;
    events.onInterruption(() => { interruptions += 1; });
    await events.connect();

    server.clients[0]?.drop();
    await events.connect();
    expect(interruptions).toBe(0);
    await events.ready();
    events.close();
  });

  it("does not report connections it closes itself", async () => {
    const server = new FakeRedis();
    const events = bus(server);
    const lost: unknown[] = [];
    events.onLost((reason) => { lost.push(reason); });
    await events.connect();

    events.close();
    expect(lost).toEqual([]);
  });

  it("fails a publish Redis does not answer and hands the publisher to the supervisor", async () => {
    const server = new FakeRedis();
    const events = bus(server);
    const lost: unknown[] = [];
    events.onLost((reason) => { lost.push(reason); });
    let interruptions = 0;
    events.onInterruption(() => { interruptions += 1; });
    const received: unknown[] = [];
    await events.subscribe("sse", (event) => { received.push(event); });
    await events.connect();

    server.paused = true;
    const started = Date.now();
    await expect(events.publish("sse", { id: 1 })).rejects.toBeInstanceOf(RedisCommandTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lost.length).toBe(1);
    await expect(events.ready()).rejects.toThrow("Connection closed");

    server.paused = false;
    await events.connect();
    await events.publish("sse", { id: 2 });
    expect(received).toEqual([{ id: 2 }]);
    expect(interruptions).toBe(0);
    events.close();
  });

  it("fails a subscription Redis does not confirm and subscribes on the next attempt", async () => {
    const server = new FakeRedis();
    server.paused = true;
    const events = bus(server);
    let interruptions = 0;
    events.onInterruption(() => { interruptions += 1; });

    await expect(events.connect()).rejects.toBeInstanceOf(RedisCommandTimeoutError);
    await expect(events.ready()).rejects.toThrow("not subscribed");

    server.paused = false;
    await events.connect();
    await events.ready();
    expect(interruptions).toBe(1);
    events.close();
  });
});
