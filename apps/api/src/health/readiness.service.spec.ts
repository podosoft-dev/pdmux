import { describe, expect, it } from "@jest/globals";
import { ReadinessService } from "./readiness.service";

describe("ReadinessService", () => {
  it("runs registered checks and removes them with the returned callback", async () => {
    const service = new ReadinessService();
    const unregister = service.register("cache", () => Promise.resolve());
    service.register("events", () => Promise.reject(new Error("unavailable")));

    await expect(service.run()).resolves.toEqual({ cache: "up", events: "down" });
    unregister();
    await expect(service.run()).resolves.toEqual({ events: "down" });
  });

  it("rejects duplicate names", () => {
    const service = new ReadinessService();
    service.register("cache", () => Promise.resolve());
    expect(() => service.register("cache", () => Promise.resolve())).toThrow(
      'Readiness check "cache" is already registered',
    );
  });
});
