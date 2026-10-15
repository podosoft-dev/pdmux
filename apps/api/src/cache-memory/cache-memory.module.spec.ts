import { describe, expect, it } from "bun:test";
import { MemoryCacheStore } from "@podosoft/podokit-runtime";

describe("memory cache provider", () => {
  it("expires values and enforces a fixed-window limit", async () => {
    let now = 1_000;
    const cache = new MemoryCacheStore({ now: () => now });
    await cache.set("short", "value", { ttlMs: 10 });
    now += 10;
    expect(await cache.get("short")).toBeNull();
    expect((await cache.incrementFixedWindow("user", { windowMs: 1_000, limit: 1 })).allowed)
      .toBe(true);
    expect((await cache.incrementFixedWindow("user", { windowMs: 1_000, limit: 1 })).allowed)
      .toBe(false);
  });
});
