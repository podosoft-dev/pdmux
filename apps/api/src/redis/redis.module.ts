import { Elysia, t } from "elysia";
import {
  type AppPlugin,
  type PodokitModule,
  READINESS,
  type ServiceKey,
} from "../core/services";
import { RedisService } from "./redis.service";
import { MemoryCacheStore, type CacheStore } from "../runtime/cache";
import { runtimeProviders } from "../runtime/providers";

export const REDIS = Symbol("redis") as ServiceKey<RedisService>;
export const CACHE = Symbol("cache") as ServiceKey<CacheStore>;

const cachePlugin: AppPlugin = ({ services }) => {
  const cache = services.resolve(CACHE);
  return new Elysia({ name: "podokit.redis" })
    .put("/cache/:key", async ({ params, body }) => {
      await cache.set(params.key, body.value, body.ttl);
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
      value: await cache.get(params.key),
    }), {
      params: t.Object({ key: t.String({ minLength: 1 }) }),
      detail: { tags: ["cache"], summary: "Read a cache value" },
    });
};

export const redisModule: PodokitModule = {
  name: "redis",
  configure: (_env, services): void => {
    if (runtimeProviders().cache === "memory") {
      const cache = new MemoryCacheStore();
      services.register(CACHE, cache, () => cache.close());
      return;
    }
    const redis = new RedisService(services.resolve(READINESS));
    services.register(REDIS, redis, () => redis.close());
    services.register(CACHE, redis);
    services.onStart(() => redis.connect());
  },
  plugin: cachePlugin,
};
