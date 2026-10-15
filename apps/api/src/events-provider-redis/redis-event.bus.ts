import { RedisClient } from "bun";
import type { EventBus, EventHandler, Unsubscribe } from "@podosoft/podokit-runtime";
import { redisConnectionUrl } from "../config/redis.connection";

export class RedisEventBus implements EventBus {
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;
  private readonly channel: string;
  private readonly maxEventBytes: number;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private listener?: (message: string) => void;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.publisher = new RedisClient(redisConnectionUrl(env), { connectionTimeout: 5_000 });
    this.subscriber = new RedisClient(redisConnectionUrl(env), { connectionTimeout: 5_000 });
    this.channel = env.EVENTS_REDIS_CHANNEL?.trim() || "podokit:events";
    this.maxEventBytes = Number(env.SSE_MAX_EVENT_BYTES ?? 65_536);
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes < 1) {
      throw new Error("SSE_MAX_EVENT_BYTES must be a positive integer");
    }
  }

  async connect(): Promise<void> {
    if (this.listener) return;
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    this.listener = (message: string): void => {
      if (Buffer.byteLength(message, "utf8") > this.maxEventBytes) return;
      try {
        const envelope = JSON.parse(message) as unknown;
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return;
        const record = envelope as Record<string, unknown>;
        if (typeof record.topic !== "string") return;
        for (const handler of this.handlers.get(record.topic) ?? []) {
          void Promise.resolve(handler(record.event)).catch(() => undefined);
        }
      } catch {
        process.stderr.write("Discard malformed event transport message\n");
      }
    };
    await this.subscriber.subscribe(this.channel, this.listener);
  }

  async ready(): Promise<void> {
    await this.connect();
    await this.publisher.ping();
  }

  async publish(topic: string, event: unknown): Promise<void> {
    const message = JSON.stringify({ topic, event });
    if (message === undefined) throw new Error("Event must be JSON serializable");
    if (Buffer.byteLength(message, "utf8") > this.maxEventBytes) {
      throw new Error(`Event exceeds maxEventBytes (${this.maxEventBytes})`);
    }
    await this.publisher.publish(this.channel, message);
  }

  async subscribe(topic: string, handler: EventHandler): Promise<Unsubscribe> {
    await this.connect();
    const handlers = this.handlers.get(topic) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(topic, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(topic);
    };
  }

  async close(): Promise<void> {
    if (this.listener) await this.subscriber.unsubscribe(this.channel, this.listener);
    this.handlers.clear();
    this.listener = undefined;
    this.publisher.close();
    this.subscriber.close();
  }
}
