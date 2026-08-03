import { describe, expect, it } from "@jest/globals";
import {
  MemoryEventsTransport,
  RedisEventsTransport,
  type RedisClientFactory,
} from "./events.transport";
import type { RedisConnectionOptions } from "../config/redis.connection";

class FakeRedisClient {
  status = "wait";
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly subscriptions: string[] = [];
  private messageListener?: (channel: string, message: string) => void;

  connect(): Promise<void> {
    this.status = "ready";
    return Promise.resolve();
  }

  publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return Promise.resolve(1);
  }

  subscribe(channel: string): Promise<number> {
    this.subscriptions.push(channel);
    return Promise.resolve(1);
  }

  ping(): Promise<string> {
    return this.status === "ready" ? Promise.resolve("PONG") : Promise.reject(new Error("down"));
  }

  quit(): Promise<string> {
    this.status = "end";
    return Promise.resolve("OK");
  }

  on(_event: "message", listener: (channel: string, message: string) => void): this {
    this.messageListener = listener;
    return this;
  }

  off(_event: "message", listener: (channel: string, message: string) => void): this {
    if (this.messageListener === listener) this.messageListener = undefined;
    return this;
  }

  emit(channel: string, message: string): void {
    this.messageListener?.(channel, message);
  }
}

describe("events transports", () => {
  it("delivers memory events through the configured handler", async () => {
    const transport = new MemoryEventsTransport({ SSE_MAX_EVENT_BYTES: "128" });
    const received: unknown[] = [];
    await transport.connect((data) => received.push(data));
    await transport.publish({ type: "changed" });
    expect(received).toEqual([{ type: "changed" }]);
  });

  it("publishes Redis events only through the subscription echo", async () => {
    const clients: FakeRedisClient[] = [];
    const factory: RedisClientFactory = (_options: RedisConnectionOptions) => {
      const client = new FakeRedisClient();
      clients.push(client);
      return client;
    };
    const transport = new RedisEventsTransport(
      {
        REDIS_URL: "redis://user:password@cache.example.com:6379/2",
        SSE_REDIS_CHANNEL: "events:test",
      },
      factory,
    );
    const received: unknown[] = [];

    await transport.connect((data) => received.push(data));
    await transport.publish({ type: "changed" });
    expect(received).toEqual([]);
    expect(clients[0]?.published).toEqual([
      { channel: "events:test", message: '{"type":"changed"}' },
    ]);

    clients[1]?.emit("events:test", '{"type":"changed"}');
    expect(received).toEqual([{ type: "changed" }]);
  });

  it("rejects events larger than the configured limit", async () => {
    const transport = new MemoryEventsTransport({ SSE_MAX_EVENT_BYTES: "8" });
    await transport.connect(() => undefined);
    await expect(transport.publish({ message: "too large" })).rejects.toThrow(
      "Event data exceeds SSE_MAX_EVENT_BYTES",
    );
  });
});
