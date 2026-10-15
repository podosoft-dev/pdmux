import { RedisClient } from "bun";
import { redisConnectionUrl } from "../config/redis.connection";
import { ReadinessService } from "../health/readiness.service";

export class RedisService {
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
