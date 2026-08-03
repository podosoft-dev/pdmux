import {
  Controller,
  Get,
  type INestApplication,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  ThrottlerModule,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import Redis from "ioredis";
import request from "supertest";
import { AllExceptionsFilter } from "../common/all-exceptions.filter";
import { RedisService } from "../redis/redis.service";

jest.mock("../auth/auth-provider", () => ({
  authRuntime: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({
  fromNodeHeaders: (headers: unknown) => headers,
}));

import {
  ProxyAwareThrottlerGuard,
  RateLimitModule,
} from "./rate-limit.module";
import {
  RateLimitIdentity,
  RateLimitIdentityExtension,
  type RateLimitRequest,
} from "./rate-limit.identity";

type StorageMode = "allow" | "blocked" | "error";
type IncrementCall = {
  ttl: number;
  limit: number;
  blockDuration: number;
};

class ContractStorage implements ThrottlerStorage {
  mode: StorageMode = "allow";
  readonly calls: IncrementCall[] = [];

  async increment(
    _key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    this.calls.push({ ttl, limit, blockDuration });
    if (this.mode === "error") throw new Error("Redis unavailable");
    return {
      totalHits: this.mode === "blocked" ? limit + 1 : 1,
      timeToExpire: 7,
      isBlocked: this.mode === "blocked",
      timeToBlockExpire: 7,
    };
  }
}

const storage = new ContractStorage();

@Controller()
class ContractController {
  @Get("ordinary")
  ordinary(): { ok: true } {
    return { ok: true };
  }

  @Post("api/auth/sign-in")
  signIn(): { ok: true } {
    return { ok: true };
  }

  @Get("site/settings")
  runtime(): { ok: true } {
    return { ok: true };
  }

  @Get("health")
  health(): { ok: true } {
    return { ok: true };
  }

  @Get("health/ready")
  ready(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      storage,
    }),
  ],
  controllers: [ContractController],
  providers: [
    {
      provide: RateLimitIdentity,
      useValue: { resolve: async () => "user:test-tracker" },
    },
    { provide: APP_GUARD, useClass: ProxyAwareThrottlerGuard },
  ],
})
class ContractModule {}

describe("ProxyAwareThrottlerGuard contract", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ContractModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  beforeEach(() => {
    storage.mode = "allow";
    storage.calls.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it("applies separate general, authentication, and runtime limits", async () => {
    await request(app.getHttpServer()).get("/ordinary").expect(200);
    await request(app.getHttpServer()).post("/api/auth/sign-in").expect(201);
    await request(app.getHttpServer()).get("/site/settings").expect(200);

    expect(storage.calls).toEqual([
      { ttl: 60_000, limit: 300, blockDuration: 60_000 },
      { ttl: 60_000, limit: 20, blockDuration: 60_000 },
      { ttl: 60_000, limit: 1000, blockDuration: 60_000 },
    ]);
  });

  it("keeps liveness and readiness outside request limiting", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
    await request(app.getHttpServer()).get("/health/ready").expect(200);
    expect(storage.calls).toHaveLength(0);
  });

  it("returns stable error envelopes for blocked and unavailable storage", async () => {
    storage.mode = "blocked";
    const blocked = await request(app.getHttpServer()).get("/ordinary").expect(429);
    expect(blocked.headers["retry-after"]).toBe("7");
    expect(blocked.body).toMatchObject({
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", statusCode: 429 },
    });

    storage.mode = "error";
    const unavailable = await request(app.getHttpServer()).get("/ordinary").expect(503);
    expect(unavailable.headers["retry-after"]).toBe("1");
    expect(unavailable.body).toMatchObject({
      success: false,
      error: { code: "RATE_LIMIT_UNAVAILABLE", statusCode: 503 },
    });
  });

  it("uses an application identity extension without a second rate-limit module", async () => {
    @Injectable()
    class ApplicationIdentityExtension extends RateLimitIdentityExtension {
      override async validatedApiKeyId(
        _request: RateLimitRequest,
        rawApiKey: string,
      ): Promise<string | undefined> {
        return rawApiKey === "application-valid" ? "application-id" : undefined;
      }
    }
    const redis = Object.create(Redis.prototype) as Redis;
    const module = await Test.createTestingModule({
      imports: [RateLimitModule],
      providers: [
        {
          provide: RateLimitIdentityExtension,
          useClass: ApplicationIdentityExtension,
        },
      ],
    })
      .overrideProvider(RedisService)
      .useValue({ client: redis })
      .compile();
    try {
      const identity = module.get(RateLimitIdentity);
      const headers = { "x-api-key": "application-valid" };
      const tracker = await identity.resolve(
        {
          headers,
          header: (name: string) =>
            headers[name.toLowerCase() as keyof typeof headers],
          socket: { remoteAddress: "10.0.0.9" },
          ip: "10.0.0.9",
          session: null,
        } as unknown as RateLimitRequest,
        { proxyHeader: "x-forwarded-for", trustedProxyHops: 0 },
      );
      expect(tracker).toMatch(/^api-key:[a-f0-9]{64}$/);
      expect(tracker).not.toContain("application-id");
    } finally {
      await module.close();
    }
  });
});
