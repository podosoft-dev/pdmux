import { RedisClient } from "bun";
import { redisConnectionUrl } from "../config/redis.connection";

export type EventHandler = (data: unknown) => void;

export interface EventsTransport {
  connect(handler: EventHandler): Promise<void>;
  publish(data: unknown): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

function maxEventBytes(env: NodeJS.ProcessEnv): number {
  const value = Number(env.SSE_MAX_EVENT_BYTES ?? 65_536);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("SSE_MAX_EVENT_BYTES must be a positive integer");
  }
  return value;
}

function encodedEvent(data: unknown, maximumBytes: number): string {
  const message = JSON.stringify(data);
  if (message === undefined) throw new Error("Event data must be JSON serializable");
  if (Buffer.byteLength(message, "utf8") > maximumBytes) {
    throw new Error("Event data exceeds SSE_MAX_EVENT_BYTES");
  }
  return message;
}

export class MemoryEventsTransport implements EventsTransport {
  private handler?: EventHandler;
  private readonly maximumBytes: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.maximumBytes = maxEventBytes(env);
  }

  connect(handler: EventHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  async publish(data: unknown): Promise<void> {
    this.handler?.(JSON.parse(encodedEvent(data, this.maximumBytes)) as unknown);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.handler = undefined;
    return Promise.resolve();
  }
}

export class RedisEventsTransport implements EventsTransport {
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;
  private readonly channel: string;
  private readonly maximumBytes: number;
  private handler?: EventHandler;
  private listener?: (message: string) => void;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const url = redisConnectionUrl(env);
    this.publisher = new RedisClient(url, { connectionTimeout: 5_000 });
    this.subscriber = new RedisClient(url, { connectionTimeout: 5_000 });
    this.channel = env.SSE_REDIS_CHANNEL?.trim() || "podokit:events";
    this.maximumBytes = maxEventBytes(env);
  }

  async connect(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.listener = (message: string): void => {
      if (Buffer.byteLength(message, "utf8") > this.maximumBytes) return;
      try {
        this.handler?.(JSON.parse(message) as unknown);
      } catch {
        process.stderr.write("Discard malformed event transport message\n");
      }
    };
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(this.channel, this.listener);
    await this.ready();
  }

  async publish(data: unknown): Promise<void> {
    await this.publisher.publish(this.channel, encodedEvent(data, this.maximumBytes));
  }

  async ready(): Promise<void> {
    if (!this.subscriber.connected) throw new Error("Redis event subscriber is not ready");
    await this.publisher.ping();
  }

  async close(): Promise<void> {
    if (this.listener) await this.subscriber.unsubscribe(this.channel, this.listener);
    this.handler = undefined;
    this.listener = undefined;
    this.publisher.close();
    this.subscriber.close();
  }
}

export function createEventsTransport(env: NodeJS.ProcessEnv = process.env): EventsTransport {
  const name = env.SSE_TRANSPORT?.trim().toLowerCase() || "memory";
  if (name === "memory") return new MemoryEventsTransport(env);
  if (name === "redis") return new RedisEventsTransport(env);
  throw new Error('SSE_TRANSPORT must be either "memory" or "redis"');
}
