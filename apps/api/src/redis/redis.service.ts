import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { redisConnectionOptions } from "../config/redis.connection";
import { ReadinessService } from "../health/readiness.service";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client = new Redis(redisConnectionOptions(process.env, {
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  }));
  private readonly subscribers: Redis[] = [];
  private unregisterReadiness?: () => void;

  constructor(@Optional() private readonly readiness?: ReadinessService) {}

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.client.ping();
    this.unregisterReadiness = this.readiness?.register("redis", async () => {
      await this.client.ping();
    });
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const sub = new Redis(redisConnectionOptions(process.env, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      connectTimeout: 5_000,
    }));
    try {
      await sub.connect();
      await sub.subscribe(channel);
    } catch (error) {
      await sub.quit().catch(() => undefined);
      throw error;
    }
    this.subscribers.push(sub);
    sub.on("message", (ch, message) => {
      if (ch === channel) handler(message);
    });
    return async () => {
      const index = this.subscribers.indexOf(sub);
      if (index >= 0) this.subscribers.splice(index, 1);
      await sub.unsubscribe(channel);
      await sub.quit();
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.unregisterReadiness?.();
    await Promise.allSettled([this.client.quit(), ...this.subscribers.map((s) => s.quit())]);
  }
}
