import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import {
  redisConnectionOptions,
  type RedisConnectionOptions,
} from "../config/redis.connection";

export type EventHandler = (data: unknown) => void;

export interface EventsTransport {
  connect(handler: EventHandler): Promise<void>;
  publish(data: unknown): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface RedisClient {
  readonly status: string;
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  on(event: "message", listener: (channel: string, message: string) => void): this;
  off(event: "message", listener: (channel: string, message: string) => void): this;
}

export type RedisClientFactory = (options: RedisConnectionOptions) => RedisClient;

function defaultRedisClientFactory(options: RedisConnectionOptions): RedisClient {
  return new Redis(options);
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
  if (message === undefined) {
    throw new Error("Event data must be JSON serializable");
  }
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
    const message = encodedEvent(data, this.maximumBytes);
    this.handler?.(JSON.parse(message) as unknown);
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
  private readonly logger = new Logger(RedisEventsTransport.name);
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;
  private readonly channel: string;
  private readonly maximumBytes: number;
  private handler?: EventHandler;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    createClient: RedisClientFactory = defaultRedisClientFactory,
  ) {
    this.channel = env.SSE_REDIS_CHANNEL?.trim() || "podokit:events";
    this.maximumBytes = maxEventBytes(env);
    this.publisher = createClient(
      redisConnectionOptions(env, {
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 5_000,
        commandTimeout: 5_000,
      }),
    );
    this.subscriber = createClient(
      redisConnectionOptions(env, {
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: null,
        connectTimeout: 5_000,
      }),
    );
  }

  private readonly onMessage = (channel: string, message: string): void => {
    if (channel !== this.channel) return;
    if (Buffer.byteLength(message, "utf8") > this.maximumBytes) {
      this.logger.warn("Discarded oversized event transport message");
      return;
    }
    try {
      this.handler?.(JSON.parse(message) as unknown);
    } catch {
      this.logger.warn("Discarded malformed event transport message");
    }
  };

  async connect(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.subscriber.on("message", this.onMessage);
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(this.channel);
      await this.ready();
    } catch (error) {
      this.subscriber.off("message", this.onMessage);
      this.handler = undefined;
      await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
      throw error;
    }
  }

  async publish(data: unknown): Promise<void> {
    await this.publisher.publish(this.channel, encodedEvent(data, this.maximumBytes));
  }

  async ready(): Promise<void> {
    if (this.subscriber.status !== "ready") {
      throw new Error("Redis event subscriber is not ready");
    }
    await this.publisher.ping();
  }

  async close(): Promise<void> {
    this.subscriber.off("message", this.onMessage);
    this.handler = undefined;
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}

export function createEventsTransport(env: NodeJS.ProcessEnv = process.env): EventsTransport {
  const name = env.SSE_TRANSPORT?.trim().toLowerCase() || "memory";
  if (name === "memory") return new MemoryEventsTransport(env);
  if (name === "redis") return new RedisEventsTransport(env);
  throw new Error('SSE_TRANSPORT must be either "memory" or "redis"');
}
