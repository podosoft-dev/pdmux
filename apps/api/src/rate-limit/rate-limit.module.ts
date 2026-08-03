import { Injectable, Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModule,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { Request } from "express";
import { ApiKeyVerifier } from "../api-key/api-key-verifier";
import { AppException } from "../common/app-exception";
import { RedisModule } from "../redis/redis.module";
import { RedisService } from "../redis/redis.service";
import { rateLimitConfig } from "./rate-limit.config";
import { RateLimitIdentity } from "./rate-limit.identity";

const config = rateLimitConfig();
const unthrottledHealthPaths = new Set(["/health", "/health/ready"]);

@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly identity: RateLimitIdentity,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { req, res } = this.getRequestResponse(requestProps.context);
    const method = typeof req.method === "string" ? req.method : "";
    const path = typeof req.path === "string" ? req.path : "";
    if (method === "GET" && unthrottledHealthPaths.has(path)) return true;

    let effective = requestProps;
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      effective = {
        ...requestProps,
        limit: config.authLimit,
        ttl: config.authTtlSeconds * 1000,
        blockDuration: config.authTtlSeconds * 1000,
      };
    } else if (method === "GET" && path === "/site/settings") {
      effective = { ...requestProps, limit: config.runtimeLimit };
    }

    try {
      return await this.withStorageTimeout(super.handleRequest(effective));
    } catch (error) {
      if (error instanceof AppException) throw error;
      if (typeof res.header === "function") {
        res.header("Retry-After", config.unavailableRetryAfterSeconds);
      }
      throw new AppException(
        "RATE_LIMIT_UNAVAILABLE",
        "Request limiting is temporarily unavailable.",
        503,
      );
    }
  }

  protected override getTracker(request: Record<string, unknown>): Promise<string> {
    return this.identity.resolve(request as unknown as Request, config);
  }

  protected override async throwThrottlingException(
    _context: Parameters<ThrottlerGuard["canActivate"]>[0],
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new AppException(
      "RATE_LIMIT_EXCEEDED",
      "Too many requests.",
      429,
    );
  }

  private async withStorageTimeout(operation: Promise<boolean>): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Rate limit storage timeout")),
            config.storageTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

@Module({
  imports: [
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ttl: config.ttlSeconds * 1000, limit: config.limit }],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  providers: [
    ApiKeyVerifier,
    RateLimitIdentity,
    ProxyAwareThrottlerGuard,
    { provide: APP_GUARD, useExisting: ProxyAwareThrottlerGuard },
  ],
  exports: [RateLimitIdentity],
})
export class RateLimitModule {}
