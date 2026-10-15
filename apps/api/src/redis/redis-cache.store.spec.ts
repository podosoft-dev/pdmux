import { describe, expect, it, mock } from "bun:test";
import {
  FIXED_WINDOW_SCRIPT,
  FIXED_WINDOW_SCRIPT_SHA,
  RedisCacheStore,
} from "./redis-cache.store";
import { RedisService } from "./redis.service";

const redisUrl = process.env.REDIS_TEST_URL;
const integrationTest = redisUrl ? it : it.skip;

type Send = (command: string, args: string[]) => Promise<unknown>;
type SetValue = (key: string, value: string, ...options: Array<string | number>) => Promise<"OK">;

function storeWith(client: { send?: Send; set?: SetValue }): RedisCacheStore {
  return new RedisCacheStore({ client } as unknown as RedisService);
}

function redisError(message: string): Error {
  return Object.assign(new Error(message), { name: "RedisError", code: "ERR_REDIS_SERVER_ERROR" });
}

describe("RedisCacheStore fixed window", () => {
  it("runs the cached script by SHA", async () => {
    const send = mock<Send>(async () => [1, 60_000]);
    const store = storeWith({ send });

    await expect(
      store.incrementFixedWindow("counter", { windowMs: 60_000, limit: 5 }),
    ).resolves.toMatchObject({ allowed: true, count: 1, remaining: 4 });
    expect(send.mock.calls).toEqual([
      ["EVALSHA", [FIXED_WINDOW_SCRIPT_SHA, "1", "counter", "60000"]],
    ]);
  });

  it("falls back to EVAL when Redis has not cached the script", async () => {
    const send = mock<Send>(async (command) => {
      if (command === "EVALSHA") throw redisError("NOSCRIPT No matching script. Please use EVAL.");
      return [2, 500];
    });
    const store = storeWith({ send });

    await expect(
      store.incrementFixedWindow("counter", { windowMs: 1_000, limit: 1 }),
    ).resolves.toMatchObject({ allowed: false, count: 2, remaining: 0 });
    expect(send.mock.calls).toEqual([
      ["EVALSHA", [FIXED_WINDOW_SCRIPT_SHA, "1", "counter", "1000"]],
      ["EVAL", [FIXED_WINDOW_SCRIPT, "1", "counter", "1000"]],
    ]);
  });

  it("propagates other Redis errors unchanged", async () => {
    const failure = redisError("LOADING Redis is loading the dataset in memory");
    const send = mock<Send>(async () => { throw failure; });
    const store = storeWith({ send });

    await expect(
      store.incrementFixedWindow("counter", { windowMs: 1_000, limit: 1 }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("RedisCacheStore set", () => {
  it("writes the value and its TTL in one command", async () => {
    const set = mock<SetValue>(async () => "OK");
    const store = storeWith({ set });

    await store.set("plain", "value");
    await store.set("expiring", "value", { ttlMs: 1_500 });

    expect(set.mock.calls).toEqual([
      ["plain", "value"],
      ["expiring", "value", "PX", 1_500],
    ]);
  });

  it("rejects an invalid TTL before writing", async () => {
    const set = mock<SetValue>(async () => "OK");
    const store = storeWith({ set });

    await expect(store.set("key", "value", { ttlMs: 0 })).rejects.toThrow("ttlMs");
    expect(set).not.toHaveBeenCalled();
  });
});

describe("RedisCacheStore integration", () => {
  integrationTest("matches the Redis script SHA and counts atomically", async () => {
    const previousUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;
    const service = new RedisService();
    const store = new RedisCacheStore(service);
    const prefix = `podokit:test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    try {
      await service.connect();
      await expect(
        service.client.send("SCRIPT", ["LOAD", FIXED_WINDOW_SCRIPT]),
      ).resolves.toBe(FIXED_WINDOW_SCRIPT_SHA);

      const counter = `${prefix}:counter`;
      const options = { windowMs: 60_000, limit: 1 };
      await expect(store.incrementFixedWindow(counter, options)).resolves.toMatchObject({
        allowed: true,
        count: 1,
      });
      await expect(store.incrementFixedWindow(counter, options)).resolves.toMatchObject({
        allowed: false,
        count: 2,
      });

      const expiring = `${prefix}:expiring`;
      await store.set(expiring, "value", { ttlMs: 60_000 });
      await expect(store.get(expiring)).resolves.toBe("value");
      expect(await service.client.pttl(expiring)).toBeGreaterThan(0);

      await service.del(counter);
      await service.del(expiring);
    } finally {
      service.close();
      if (previousUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousUrl;
    }
  });
});
