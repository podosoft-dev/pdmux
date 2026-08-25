import type { RedisClient } from "bun";
import { AppException } from "../common/app-exception";
import { API_KEY_VERIFIER } from "../api-key/api-key.module";
import {
  REQUEST_GUARDS,
  type PodokitModule,
  type RequestGuardContext,
  type ServiceKey,
} from "../core/services";
import { REDIS } from "../redis/redis.module";
import { rateLimitConfig, type RateLimitConfig } from "./rate-limit.config";
import { RateLimitIdentity } from "./rate-limit.identity";

export interface RateLimitIncrement {
  count: number;
  retryAfterSeconds: number;
}

export interface RateLimitStorage {
  increment(key: string, ttlSeconds: number): Promise<RateLimitIncrement>;
}

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

export class RedisRateLimitStorage implements RateLimitStorage {
  constructor(private readonly client: RedisClient) {}

  async increment(key: string, ttlSeconds: number): Promise<RateLimitIncrement> {
    const result = await this.client.send("EVAL", [
      INCREMENT_SCRIPT,
      "1",
      key,
      String(ttlSeconds),
    ]);
    if (!Array.isArray(result)) throw new Error("Redis returned an invalid rate-limit result");
    const count = resultNumber(result[0]);
    const retryAfterSeconds = resultNumber(result[1]);
    if (count === undefined || retryAfterSeconds === undefined) {
      throw new Error("Redis returned an invalid rate-limit counter");
    }
    return { count, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }
}

type LimitProfile = { name: string; ttlSeconds: number; limit: number };

export class RateLimiter {
  constructor(
    private readonly config: RateLimitConfig,
    private readonly identity: RateLimitIdentity,
    private readonly storage: RateLimitStorage,
  ) {}

  async enforce(context: RequestGuardContext): Promise<void> {
    const { request } = context;
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      ["/health", "/health/ready", "/api-docs", "/api-docs-json", "/api-docs-elysia-json"].includes(path)
    ) return;

    try {
      const profile = this.profile(request.method, path);
      const tracker = await this.identity.resolve(request, context.remoteAddress, this.config);
      await this.enforceCustom(profile.name, tracker, profile.ttlSeconds, profile.limit, context.setHeader);
    } catch (error) {
      if (error instanceof AppException) throw error;
      context.setHeader("Retry-After", String(this.config.unavailableRetryAfterSeconds));
      throw new AppException(
        "RATE_LIMIT_UNAVAILABLE",
        "Request limiting is temporarily unavailable.",
        503,
      );
    }
  }

  async enforceCustom(
    name: string,
    tracker: string,
    ttlSeconds: number,
    limit: number,
    setHeader: (name: string, value: string) => void,
  ): Promise<void> {
    try {
      const result = await this.withTimeout(
        this.storage.increment(`${this.config.keyPrefix}:${name}:${tracker}`, ttlSeconds),
      );
      setHeader("RateLimit-Limit", String(limit));
      setHeader("RateLimit-Remaining", String(Math.max(0, limit - result.count)));
      if (result.count > limit) {
        setHeader("Retry-After", String(result.retryAfterSeconds));
        throw new AppException("RATE_LIMIT_EXCEEDED", "Too many requests.", 429);
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
      setHeader("Retry-After", String(this.config.unavailableRetryAfterSeconds));
      throw new AppException(
        "RATE_LIMIT_UNAVAILABLE",
        "Request limiting is temporarily unavailable.",
        503,
      );
    }
  }

  private profile(method: string, path: string): LimitProfile {
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      return { name: "auth", ttlSeconds: this.config.authTtlSeconds, limit: this.config.authLimit };
    }
    if (method === "GET" && path === "/site/settings") {
      return { name: "runtime", ttlSeconds: this.config.ttlSeconds, limit: this.config.runtimeLimit };
    }
    return { name: "general", ttlSeconds: this.config.ttlSeconds, limit: this.config.limit };
  }

  private async withTimeout(operation: Promise<RateLimitIncrement>): Promise<RateLimitIncrement> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Rate limit storage timeout")),
            this.config.storageTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export const RATE_LIMITER = Symbol("rate-limiter") as ServiceKey<RateLimiter>;

export const rateLimitModule: PodokitModule = {
  name: "rate-limit",
  configure: (_env, services): void => {
    const limiter = new RateLimiter(
      rateLimitConfig(),
      new RateLimitIdentity(services.resolve(API_KEY_VERIFIER), services),
      new RedisRateLimitStorage(services.resolve(REDIS).client),
    );
    services.register(RATE_LIMITER, limiter);
    services.resolve(REQUEST_GUARDS).register((context) => limiter.enforce(context));
  },
};
