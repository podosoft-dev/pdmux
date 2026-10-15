import { createHash } from "node:crypto";
import type { RedisClient } from "bun";
import type {
  CacheSetOptions,
  CacheStore,
  FixedWindowOptions,
  FixedWindowResult,
} from "@podosoft/podokit-runtime";
import type { RedisService } from "./redis.service";

export const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export const FIXED_WINDOW_SCRIPT_SHA = createHash("sha1").update(FIXED_WINDOW_SCRIPT).digest("hex");

function isMissingScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

function resultNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class RedisCacheStore implements CacheStore {
  private readonly client: RedisClient;

  constructor(private readonly redis: RedisService) {
    this.client = redis.client;
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, options: CacheSetOptions = {}): Promise<void> {
    if (options.ttlMs === undefined) {
      await this.client.set(key, value);
      return;
    }
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new Error("ttlMs must be a positive integer");
    }
    await this.client.set(key, value, "PX", options.ttlMs);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(key)) > 0;
  }

  async incrementFixedWindow(
    key: string,
    options: FixedWindowOptions,
  ): Promise<FixedWindowResult> {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("windowMs must be a positive integer");
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    const result = await this.runFixedWindow(key, options.windowMs);
    if (!Array.isArray(result)) throw new Error("Redis returned an invalid cache counter");
    const count = resultNumber(result[0]);
    const ttlMs = resultNumber(result[1]);
    if (count === undefined || ttlMs === undefined) {
      throw new Error("Redis returned an invalid cache counter");
    }
    return {
      allowed: count <= options.limit,
      count,
      remaining: Math.max(0, options.limit - count),
      resetAt: Date.now() + Math.max(1, ttlMs),
    };
  }

  private async runFixedWindow(key: string, windowMs: number): Promise<unknown> {
    const args = ["1", key, String(windowMs)];
    try {
      return await this.client.send("EVALSHA", [FIXED_WINDOW_SCRIPT_SHA, ...args]);
    } catch (error) {
      // Redis forgets scripts on restart, failover, or SCRIPT FLUSH; EVAL reloads it.
      if (!isMissingScript(error)) throw error;
      return this.client.send("EVAL", [FIXED_WINDOW_SCRIPT, ...args]);
    }
  }

  close(): void {}
}
