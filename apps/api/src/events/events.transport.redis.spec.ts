import { describe, expect, it } from "@jest/globals";
import { RedisEventsTransport } from "./events.transport";

const redisUrl = process.env.REDIS_TEST_URL;
const integrationTest = redisUrl ? it : it.skip;

describe("RedisEventsTransport integration", () => {
  integrationTest("delivers once to every connected replica", async () => {
    const channel = `podokit:test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const env = {
      REDIS_URL: redisUrl,
      SSE_REDIS_CHANNEL: channel,
      SSE_MAX_EVENT_BYTES: "1024",
    };
    const first = new RedisEventsTransport(env);
    const second = new RedisEventsTransport(env);
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];

    try {
      await first.connect((data) => firstEvents.push(data));
      await second.connect((data) => secondEvents.push(data));
      await first.publish({ type: "replica-test" });

      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        (firstEvents.length < 1 || secondEvents.length < 1)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(firstEvents).toEqual([{ type: "replica-test" }]);
      expect(secondEvents).toEqual([{ type: "replica-test" }]);
      await expect(first.ready()).resolves.toBeUndefined();
      await expect(second.ready()).resolves.toBeUndefined();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
