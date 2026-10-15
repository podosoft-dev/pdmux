import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { ReadinessService } from "./readiness.service";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  setSystemTime();
});

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

  it("reports a check that exceeds the timeout as down with the reason", async () => {
    const failures: Array<[string, string]> = [];
    const service = new ReadinessService({
      timeoutMs: 20,
      cacheMs: 0,
      onCheckFailure: (name, reason) => failures.push([name, reason]),
    });
    service.register("storage", () => new Promise<void>(() => {}));
    service.register("cache", () => Promise.resolve());

    const started = performance.now();
    await expect(service.run()).resolves.toEqual({ storage: "down", cache: "up" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(failures).toEqual([["storage", 'Readiness check "storage" timed out after 20 ms']]);
  });

  it("reports the error message of a failed check", async () => {
    const failures: Array<[string, string]> = [];
    const service = new ReadinessService({
      cacheMs: 0,
      onCheckFailure: (name, reason) => failures.push([name, reason]),
    });
    service.register("events", () => Promise.reject(new Error("connection refused")));
    service.register("cache", () => {
      throw new Error("not connected");
    });

    await expect(service.run()).resolves.toEqual({ events: "down", cache: "down" });
    expect(Object.fromEntries(failures)).toEqual({
      events: "connection refused",
      cache: "not connected",
    });
  });

  it("reuses a finished evaluation until the cache window ends", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let calls = 0;
    const service = new ReadinessService({ cacheMs: 2_000 });
    service.register("cache", async () => {
      calls += 1;
    });

    await service.run();
    setSystemTime(new Date("2026-01-01T00:00:01.999Z"));
    await service.run();
    expect(calls).toBe(1);

    setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    await service.run();
    expect(calls).toBe(2);
  });

  it("caches a failed evaluation for the same window", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let available = false;
    const service = new ReadinessService({ cacheMs: 2_000 });
    service.register("cache", async () => {
      if (!available) throw new Error("unavailable");
    });

    await expect(service.run()).resolves.toEqual({ cache: "down" });
    available = true;
    await expect(service.run()).resolves.toEqual({ cache: "down" });
    setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    await expect(service.run()).resolves.toEqual({ cache: "up" });
  });

  it("evaluates on every run when the cache is disabled", async () => {
    let calls = 0;
    const service = new ReadinessService({ cacheMs: 0 });
    service.register("cache", async () => {
      calls += 1;
    });

    await service.run();
    await service.run();
    await service.run();
    expect(calls).toBe(3);
  });

  it("shares one evaluation between concurrent runs", async () => {
    let calls = 0;
    const gate = deferred();
    const service = new ReadinessService({ cacheMs: 0 });
    service.register("cache", async () => {
      calls += 1;
      await gate.promise;
    });

    const runs = [service.run(), service.run(), service.run()];
    gate.resolve();
    const results = await Promise.all(runs);

    expect(calls).toBe(1);
    expect(results).toEqual([{ cache: "up" }, { cache: "up" }, { cache: "up" }]);
    await service.run();
    expect(calls).toBe(2);
  });

  it("does not share or cache an evaluation across a registration change", async () => {
    const gate = deferred();
    const service = new ReadinessService({ cacheMs: 60_000 });
    service.register("cache", () => gate.promise);

    const before = service.run();
    service.register("events", () => Promise.resolve());
    const after = service.run();
    gate.resolve();

    await expect(before).resolves.toEqual({ cache: "up" });
    await expect(after).resolves.toEqual({ cache: "up", events: "up" });
    await expect(service.run()).resolves.toEqual({ cache: "up", events: "up" });
  });

  it("returns a copy that callers cannot use to change the cached result", async () => {
    const service = new ReadinessService({ cacheMs: 60_000 });
    service.register("cache", () => Promise.resolve());

    const first = await service.run();
    first.cache = "down";
    await expect(service.run()).resolves.toEqual({ cache: "up" });
  });
});
