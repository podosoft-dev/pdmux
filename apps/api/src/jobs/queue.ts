import type { ConnectionOptions } from "bullmq";
import { redisCommandTimeoutMs, redisConnectionOptions } from "../config/redis.connection";

export const DEMO_QUEUE = "demo";

/** Wait before reconnect attempt `attempt`: 250 ms, doubling up to 5 seconds. */
export function reconnectDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

/** Workers block on Redis, so BullMQ requires their commands to wait for a reply indefinitely. */
export function redisConnection(env: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  return {
    ...redisConnectionOptions(env, { maxRetriesPerRequest: null }),
    retryStrategy: reconnectDelay,
  };
}

/**
 * The API's connection for adding and reading jobs. Commands fail at once while
 * it is disconnected and wait at most `REDIS_COMMAND_TIMEOUT_MS` for a reply, so
 * a request that enqueues a job cannot hang on Redis. It does not reconnect by
 * itself: the service registry's supervisor reopens it.
 */
export function producerConnection(env: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  return {
    ...redisConnectionOptions(env, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      commandTimeout: redisCommandTimeoutMs(env),
    }),
    retryStrategy: () => null,
  };
}
