import { AppException } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import { CACHE } from "@podosoft/podokit-runtime";
import { PROVIDERS } from "../config/providers";
import {
  type AppPlugin,
  type PodokitModule,
  READINESS,
  type ServiceKey,
} from "../core/services";
import { RedisService } from "./redis.service";
import { RedisCacheStore } from "./redis-cache.store";

export const REDIS = Symbol("redis") as ServiceKey<RedisService>;

/** Answers 503 CACHE_UNAVAILABLE while Redis cannot be reached; other Redis errors stay 500. */
async function withCache<T>(redis: RedisService, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!redis.isUnavailable(error)) throw error;
    throw new AppException("CACHE_UNAVAILABLE", "The cache is temporarily unavailable.", 503);
  }
}

const cachePlugin: AppPlugin = ({ services }) => {
  if (PROVIDERS.cache !== "redis") return new Elysia({ name: "podokit.redis.inactive" });
  const redis = services.resolve(REDIS);
  return new Elysia({ name: "podokit.redis" })
    .put("/cache/:key", async ({ params, body }) => {
      await withCache(redis, () => redis.set(params.key, body.value, body.ttl));
      return { key: params.key };
    }, {
      params: t.Object({ key: t.String({ minLength: 1 }) }),
      body: t.Object({
        value: t.String(),
        ttl: t.Optional(t.Integer({ minimum: 1 })),
      }),
      detail: { tags: ["cache"], summary: "Store a cache value" },
    })
    .get("/cache/:key", async ({ params }) => ({
      key: params.key,
      value: await withCache(redis, () => redis.get(params.key)),
    }), {
      params: t.Object({ key: t.String({ minLength: 1 }) }),
      detail: { tags: ["cache"], summary: "Read a cache value" },
    });
};

export const redisModule: PodokitModule = {
  name: "redis",
  configure: (_env, services): void => {
    if (PROVIDERS.cache !== "redis") return;
    const redis = new RedisService();
    services.register(REDIS, redis, () => redis.close());
    services.register(CACHE, new RedisCacheStore(redis));
    services.resolve(READINESS).register("redis", () => redis.ping());
    services.supervise("redis", redis);
  },
  plugin: cachePlugin,
};
