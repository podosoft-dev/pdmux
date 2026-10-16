import { CACHE, RATE_LIMIT_ROUTES, type CacheStore } from "@podosoft/podokit-runtime";
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
import { defaultRateLimitRoutes, generalProfile, type RateLimitRoutes } from "./rate-limit.routes";

export { RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
export type { RateLimitProfile, RateLimitRoute, RateLimitRouteRegistry } from "@podosoft/podokit-runtime";

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

export class RateLimiter {
  constructor(
    private readonly config: RateLimitConfig,
    private readonly identity: RateLimitIdentity,
    private readonly storage: RateLimitStorage,
    readonly routes: RateLimitRoutes = defaultRateLimitRoutes(config),
  ) {}

  async enforce(context: RequestGuardContext): Promise<void> {
    const { request } = context;
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      ["/health", "/health/ready", "/api-docs", "/api-docs-json", "/api-docs-elysia-json"].includes(path)
    ) return;

    const profile = this.routes.resolve(request.method, path) ?? generalProfile(this.config);
    if (profile === "exempt") return;
    try {
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
    // Other modules may configure before this one, so they register routes
    // from their plugin factory, and applications from configureServices.
    services.register(RATE_LIMIT_ROUTES, limiter.routes);
    services.resolve(REQUEST_GUARDS).register((context) => limiter.enforce(context));
  },
};
