import { redisConnectionOptions, type RedisConnectionOptions } from "../config/redis.connection";

export const DEMO_QUEUE = "demo";

export function redisConnection(): RedisConnectionOptions {
  return redisConnectionOptions(process.env, { maxRetriesPerRequest: null });
}
