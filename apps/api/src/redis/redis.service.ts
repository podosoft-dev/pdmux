import { RedisClient } from "bun";
import { redisConnectionUrl } from "../config/redis.connection";
import { ReadinessService } from "../health/readiness.service";
import type { CacheIncrement, CacheStore } from "../runtime/cache";

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

function resultNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class RedisService implements CacheStore {
  readonly client: RedisClient;
  private readonly subscribers: RedisClient[] = [];
  private unregisterReadiness?: () => void;

  constructor(private readonly readiness?: ReadinessService) {
    this.client = new RedisClient(redisConnectionUrl(), {
      connectionTimeout: 5_000,
      enableOfflineQueue: false,
      maxRetries: 1,
    });
  }

  async connect(): Promise<void> {
    if (!this.client.connected) await this.client.connect();
    await this.client.ping();
    this.unregisterReadiness ??= this.readiness?.register("redis", async () => {
      await this.client.ping();
    });
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.client.set(key, value);
    if (ttlSeconds !== undefined) await this.client.expire(key, ttlSeconds);
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  delete(key: string): Promise<number> {
    return this.del(key);
  }

  async incrementFixedWindow(key: string, ttlSeconds: number): Promise<CacheIncrement> {
    const result = await this.client.send("EVAL", [INCREMENT_SCRIPT, "1", key, String(ttlSeconds)]);
    if (!Array.isArray(result)) throw new Error("Redis returned an invalid cache counter");
    const count = resultNumber(result[0]);
    const retryAfterSeconds = resultNumber(result[1]);
    if (count === undefined || retryAfterSeconds === undefined) {
      throw new Error("Redis returned an invalid cache counter");
    }
    return { count, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    const subscriber = await this.client.duplicate();
    await subscriber.connect();
    const listener = (message: string): void => handler(message);
    await subscriber.subscribe(channel, listener);
    this.subscribers.push(subscriber);
    return async () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index >= 0) this.subscribers.splice(index, 1);
      await subscriber.unsubscribe(channel, listener);
      subscriber.close();
    };
  }

  close(): void {
    this.unregisterReadiness?.();
    for (const subscriber of this.subscribers) subscriber.close();
    this.client.close();
  }
}
