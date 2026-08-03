import { describe, expect, it } from "@jest/globals";
import { ReadinessService } from "../health/readiness.service";
import { RedisService } from "./redis.service";

const redisUrl = process.env.REDIS_TEST_URL;
const integrationTest = redisUrl ? it : it.skip;

describe("RedisService integration", () => {
  integrationTest("uses authenticated settings and registers readiness", async () => {
    const previousUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;
    const readiness = new ReadinessService();
    const service = new RedisService(readiness);
    const key = `podokit:test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    try {
      await service.onModuleInit();
      await service.set(key, "value", 10);
      await expect(service.get(key)).resolves.toBe("value");
      await expect(readiness.run()).resolves.toEqual({ redis: "up" });
      await service.del(key);
    } finally {
      await service.onModuleDestroy();
      if (previousUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousUrl;
    }
  });
});
