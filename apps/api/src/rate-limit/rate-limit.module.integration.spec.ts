import { Controller, Get, Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, it, jest } from "@jest/globals";
import request from "supertest";
import { AllExceptionsFilter } from "../common/all-exceptions.filter";
import { ReadinessService } from "../health/readiness.service";

jest.mock("../auth/auth-provider", () => ({
  authRuntime: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({
  fromNodeHeaders: (headers: unknown) => headers,
}));

import { RateLimitModule } from "./rate-limit.module";

@Global()
@Module({
  providers: [ReadinessService],
  exports: [ReadinessService],
})
class TestReadinessModule {}

@Controller()
class TestController {
  @Get("ordinary")
  ordinary(): { ok: true } {
    return { ok: true };
  }

  @Get("health")
  health(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [TestReadinessModule, RateLimitModule],
  controllers: [TestController],
})
class TestApplicationModule {}

const redisUrl = process.env.REDIS_TEST_URL;
const integrationTest = redisUrl ? it : it.skip;

describe("RateLimitModule integration", () => {
  integrationTest("shares counters across replicas and bypasses health probes", async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;
    const firstModule = await Test.createTestingModule({
      imports: [TestApplicationModule],
    }).compile();
    const secondModule = await Test.createTestingModule({
      imports: [TestApplicationModule],
    }).compile();
    const first = firstModule.createNestApplication();
    const second = secondModule.createNestApplication();

    try {
      first.useGlobalFilters(new AllExceptionsFilter());
      second.useGlobalFilters(new AllExceptionsFilter());
      await Promise.all([first.init(), second.init()]);
      const clientAddress = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      await request(first.getHttpServer())
        .get("/ordinary")
        .set("x-forwarded-for", clientAddress)
        .expect(200);
      const limited = await request(second.getHttpServer())
        .get("/ordinary")
        .set("x-forwarded-for", clientAddress)
        .expect(429);
      if (
        limited.body?.error?.code !== "RATE_LIMIT_EXCEEDED" ||
        !limited.headers["retry-after"]
      ) {
        throw new Error("Shared rate-limit response contract is invalid");
      }

      for (let index = 0; index < 3; index += 1) {
        await request(index % 2 === 0 ? first.getHttpServer() : second.getHttpServer())
          .get("/health")
          .set("x-forwarded-for", clientAddress)
          .expect(200);
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }
  });
});
