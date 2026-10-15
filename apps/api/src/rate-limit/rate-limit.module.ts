import { CACHE, type CacheStore } from "@podosoft/podokit-runtime";
import { AppException } from "../common/app-exception";
import { API_KEY_VERIFIER } from "../api-key/api-key.module";
import {
  REQUEST_GUARDS,
  type PodokitModule,
  type RequestGuardContext,
  type ServiceKey,
} from "../core/services";
import {
  rateLimitConfig,
  sessionSigningSecret,
  type RateLimitConfig,
} from "./rate-limit.config";
import { RateLimitIdentity } from "./rate-limit.identity";

export interface RateLimitIncrement {
  count: number;
  retryAfterSeconds: number;
}

export interface RateLimitStorage {
  increment(key: string, ttlSeconds: number): Promise<RateLimitIncrement>;
}

export class CacheRateLimitStorage implements RateLimitStorage {
  constructor(private readonly cache: CacheStore) {}

  async increment(key: string, ttlSeconds: number): Promise<RateLimitIncrement> {
    const result = await this.cache.incrementFixedWindow(key, {
      windowMs: ttlSeconds * 1_000,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return {
      count: result.count,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000)),
    };
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
    if (
      method === "GET" &&
      (path === "/api/auth/get-session" || path === "/site/settings")
    ) {
      return { name: "runtime", ttlSeconds: this.config.ttlSeconds, limit: this.config.runtimeLimit };
    }
    // Admin reads need an admin session and are not credential attempts; the
    // server-paged admin tables issue one per page, sort, or search.
    if (method === "GET" && path.startsWith("/api/auth/admin/")) {
      return { name: "general", ttlSeconds: this.config.ttlSeconds, limit: this.config.limit };
    }
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      return { name: "auth", ttlSeconds: this.config.authTtlSeconds, limit: this.config.authLimit };
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
      new RateLimitIdentity(
        services.resolve(API_KEY_VERIFIER),
        services,
        sessionSigningSecret(),
      ),
      new CacheRateLimitStorage(services.resolve(CACHE)),
    );
    services.register(RATE_LIMITER, limiter);
    services.resolve(REQUEST_GUARDS).register((context) => limiter.enforce(context));
  },
};
