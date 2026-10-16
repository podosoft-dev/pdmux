import { describe, expect, test } from "bun:test";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { validateEnv } from "../config/env.validation";
import { PROVIDERS } from "../config/providers";
import {
  AccessPolicy,
  ConnectionSupervisor,
  createCoreServices,
  OpenApiRegistry,
  REQUEST_IDENTITY,
  RequestGuardRegistry,
  ServiceRegistry,
  type ConnectionEvents,
  type RetryTimer,
  type SupervisedConnection,
} from "./services";

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

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

describe("ServiceRegistry supervision", () => {
  test("starts and runs start hooks while a supervised dependency is down", async () => {
    const registry = new ServiceRegistry();
    let attempts = 0;
    let hookRan = false;
    registry.supervise("redis", {
      connect: () => {
        attempts += 1;
        return Promise.reject(new Error("Connection closed"));
      },
    });
    registry.onStart(() => { hookRan = true; });
    registry.freeze();

    await registry.start();
    expect(hookRan).toBe(true);
    expect(attempts).toBe(1);
    await registry.close();
    await Bun.sleep(400);
    expect(attempts).toBe(1);
  });

  test("connects a reachable dependency before the start hooks run", async () => {
    const registry = new ServiceRegistry();
    const order: string[] = [];
    registry.supervise("database", {
      connect: async () => {
        await Bun.sleep(5);
        order.push("connected");
      },
    });
    registry.onStart(() => { order.push("hook"); });
    registry.freeze();

    await registry.start();
    expect(order).toEqual(["connected", "hook"]);
    await registry.close();
  });
});

interface FakeTimer extends RetryTimer {
  delays: number[];
  pending(): number;
  fire(): Promise<void>;
}

function fakeTimer(): FakeTimer {
  const tasks: Array<{ task: () => void; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    delays,
    after: (delayMs, task) => {
      const entry = { task, cancelled: false };
      delays.push(delayMs);
      tasks.push(entry);
      return () => { entry.cancelled = true; };
    },
    pending: () => tasks.filter((entry) => !entry.cancelled).length,
    fire: async () => {
      const entry = tasks.shift();
      if (entry && !entry.cancelled) entry.task();
      await Bun.sleep(0);
    },
  };
}

function recordingEvents(): ConnectionEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    unavailable: (name, reason) => { log.push(`unavailable ${name}: ${reason}`); },
    restored: (name) => { log.push(`restored ${name}`); },
  };
}

class FlakyConnection implements SupervisedConnection {
  attempts = 0;
  failuresLeft = 0;
  private listener?: (reason: unknown) => void;

  connect(): Promise<void> {
    this.attempts += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      return Promise.reject(new Error("Connection closed"));
    }
    return Promise.resolve();
  }

  onLost(listener: (reason: unknown) => void): void {
    this.listener = listener;
  }

  drop(): void {
    this.listener?.(new Error("Connection reset"));
  }
}

describe("ConnectionSupervisor", () => {
  const policy = { initialDelayMs: 100, maxDelayMs: 400 };

  test("retries with doubling delays up to the cap and reports each state change once", async () => {
    const connection = new FlakyConnection();
    connection.failuresLeft = 5;
    const timer = fakeTimer();
    const events = recordingEvents();
    const supervisor = new ConnectionSupervisor("redis", connection, events, { policy, timer });

    await supervisor.start();
    expect(supervisor.connected).toBe(false);
    while (timer.pending() > 0) await timer.fire();

    expect(connection.attempts).toBe(6);
    expect(timer.delays).toEqual([100, 200, 400, 400, 400]);
    expect(events.log).toEqual(["unavailable redis: Connection closed", "restored redis"]);
    expect(supervisor.connected).toBe(true);
  });

  test("reopens a lost connection and starts the backoff over", async () => {
    const connection = new FlakyConnection();
    const timer = fakeTimer();
    const events = recordingEvents();
    const supervisor = new ConnectionSupervisor("redis", connection, events, { policy, timer });
    await supervisor.start();
    expect(supervisor.connected).toBe(true);

    connection.failuresLeft = 1;
    connection.drop();
    connection.drop();
    expect(supervisor.connected).toBe(false);
    expect(timer.pending()).toBe(1);
    while (timer.pending() > 0) await timer.fire();

    expect(timer.delays).toEqual([100, 200]);
    expect(connection.attempts).toBe(3);
    expect(events.log).toEqual(["unavailable redis: Connection reset", "restored redis"]);
    expect(supervisor.connected).toBe(true);
  });

  test("tries again when the connection drops while an attempt runs", async () => {
    const connection = new FlakyConnection();
    const timer = fakeTimer();
    const supervisor = new ConnectionSupervisor("events", {
      connect: async () => {
        await connection.connect();
        if (connection.attempts === 1) connection.drop();
      },
      onLost: (listener) => connection.onLost(listener),
    }, recordingEvents(), { policy, timer });

    await supervisor.start();
    expect(supervisor.connected).toBe(false);
    await timer.fire();
    expect(connection.attempts).toBe(2);
    expect(supervisor.connected).toBe(true);
  });

  test("stops retrying once stopped", async () => {
    const connection = new FlakyConnection();
    connection.failuresLeft = 10;
    const timer = fakeTimer();
    const supervisor = new ConnectionSupervisor("redis", connection, recordingEvents(), { policy, timer });
    await supervisor.start();
    expect(timer.pending()).toBe(1);

    supervisor.stop();
    expect(timer.pending()).toBe(0);
    connection.drop();
    await timer.fire();
    expect(connection.attempts).toBe(1);
    expect(timer.pending()).toBe(0);
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

  test("applies GET rules to HEAD requests and leaves other methods alone", () => {
    const policy = new AccessPolicy();
    policy.register("GET", "/profile-images/:fileName", "public");
    policy.register("POST", "/uploads", "public");
    policy.register("GET", "/reports/:id", "api-key");

    const head = (path: string): Request => new Request(`http://localhost${path}`, { method: "HEAD" });
    expect(policy.resolve(head("/profile-images/a.png"))).toBe("public");
    expect(policy.resolve(head("/reports/1"))).toBe("api-key");
    expect(policy.resolve(head("/uploads"))).toBe("session");
    expect(policy.resolve(head("/todos"))).toBe("session");
    expect(policy.resolve(new Request("http://localhost/profile-images/a.png", { method: "DELETE" }))).toBe("session");

    policy.register("HEAD", "/profile-images/:fileName", "session");
    expect(policy.resolve(head("/profile-images/a.png"))).toBe("session");
    expect(policy.resolve(new Request("http://localhost/profile-images/a.png"))).toBe("public");
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

describe("RequestIdentity", () => {
  test("treats every request as anonymous until an auth module overrides it", async () => {
    const services = createCoreServices(validateEnv({
      NODE_ENV: "test",
      DATABASE_URL: databaseProvider() === "sqlite"
        ? "sqlite://:memory:"
        : "postgres://podokit:podokit@localhost:5432/podokit",
    }));
    const identity = services.resolve(REQUEST_IDENTITY);
    const request = new Request("http://localhost/todos");
    try {
      expect(await identity.userId(request)).toBeUndefined();
      expect(await identity.isAdmin(request)).toBe(false);
      expect(await identity.roles(request)).toEqual([]);
      expect(await identity.activeOrganizationId(request)).toBeUndefined();
    } finally {
      await services.close();
    }
  });
});
