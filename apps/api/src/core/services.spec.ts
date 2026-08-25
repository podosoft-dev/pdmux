import { describe, expect, test } from "bun:test";
import {
  AccessPolicy,
  OpenApiRegistry,
  RequestGuardRegistry,
  ServiceRegistry,
} from "./services";

describe("ServiceRegistry", () => {
  test("awaits startup in registration order and starts only once", async () => {
    const registry = new ServiceRegistry();
    const order: number[] = [];
    registry.onStart(async () => { order.push(1); });
    registry.onStart(() => { order.push(2); });
    registry.freeze();

    await Promise.all([registry.start(), registry.start()]);
    expect(order).toEqual([1, 2]);
  });

  test("closes in reverse order and closes only once", async () => {
    const registry = new ServiceRegistry();
    const order: number[] = [];
    const first = Symbol("first");
    const second = Symbol("second");
    registry.register(first, true, () => { order.push(1); });
    registry.register(second, true, async () => { order.push(2); });

    await Promise.all([registry.close(), registry.close()]);
    expect(order).toEqual([2, 1]);
  });

  test("rejects startup before later starters can run", async () => {
    const registry = new ServiceRegistry();
    let reached = false;
    registry.onStart(() => { throw new Error("dependency unavailable"); });
    registry.onStart(() => { reached = true; });

    await expect(registry.start()).rejects.toThrow("dependency unavailable");
    expect(reached).toBe(false);
  });
});

describe("AccessPolicy", () => {
  test("defaults to session access", () => {
    const policy = new AccessPolicy();
    expect(policy.resolve(new Request("http://localhost/todos"))).toBe("session");
  });

  test("matches methods, parameters, and wildcard routes", () => {
    const policy = new AccessPolicy();
    policy.register("GET", "/blog/:slug", "public");
    policy.register("*", "/api/auth/*", "public");

    expect(policy.resolve(new Request("http://localhost/blog/hello"))).toBe("public");
    expect(policy.resolve(new Request("http://localhost/blog/hello", { method: "POST" }))).toBe("session");
    expect(policy.resolve(new Request("http://localhost/api/auth/sign-in/email"))).toBe("public");
  });

  test("uses the most recently registered matching rule", () => {
    const policy = new AccessPolicy();
    policy.register("*", "/content/*", "public");
    policy.register("POST", "/content/:slug", "session");

    expect(policy.resolve(new Request("http://localhost/content/post", { method: "POST" }))).toBe("session");
  });
});

describe("RequestGuardRegistry", () => {
  test("runs guards in registration order", async () => {
    const registry = new RequestGuardRegistry();
    const order: number[] = [];
    registry.register(() => { order.push(1); });
    registry.register(async () => { order.push(2); });

    await registry.run({
      request: new Request("http://localhost/health"),
      setHeader: () => undefined,
    });
    expect(order).toEqual([1, 2]);
  });
});

describe("OpenApiRegistry", () => {
  test("rejects duplicate contributor names", () => {
    const registry = new OpenApiRegistry();
    registry.register("auth", () => ({ document: {} }));
    expect(() => registry.register("auth", () => ({ document: {} }))).toThrow("already exists");
  });
});
