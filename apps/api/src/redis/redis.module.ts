import { Elysia, t } from "elysia";
import {
  type AppPlugin,
  type PodokitModule,
  READINESS,
  type ServiceKey,
} from "../core/services";
import { RedisService } from "./redis.service";

export const REDIS = Symbol("redis") as ServiceKey<RedisService>;

const cachePlugin: AppPlugin = ({ services }) => {
  const redis = services.resolve(REDIS);
  return new Elysia({ name: "podokit.redis" })
    .put("/cache/:key", async ({ params, body }) => {
      await redis.set(params.key, body.value, body.ttl);
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
      value: await redis.get(params.key),
    }), {
      params: t.Object({ key: t.String({ minLength: 1 }) }),
      detail: { tags: ["cache"], summary: "Read a cache value" },
    });
};

export const redisModule: PodokitModule = {
  name: "redis",
  configure: (_env, services): void => {
    const redis = new RedisService(services.resolve(READINESS));
    services.register(REDIS, redis, () => redis.close());
    services.onStart(() => redis.connect());
  },
  plugin: cachePlugin,
};
