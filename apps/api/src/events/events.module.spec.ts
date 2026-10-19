import { afterEach, describe, expect, it } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import { EVENTS, MemoryEventBus } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import { validateEnv } from "../config/env.validation";
import { READINESS, SHUTDOWN, ServiceRegistry, type RequestIdentity } from "../core/services";
import { Shutdown } from "../core/shutdown";
import { ReadinessService } from "../health/readiness.service";
import {
  eventsModule,
  eventsRoutes,
  maxStreamsPerUser,
  requestEventIdentity,
  SSE_EVENTS,
  type EventIdentity,
} from "./events.module";
import { EventsService } from "./events.service";

/** Maps the `x-user`, `x-admin`, `x-roles`, and `x-org` test headers to the request identity. */
const headerIdentity: RequestIdentity = {
  userId: async (request) => request.headers.get("x-user") ?? undefined,
  isAdmin: async (request) => request.headers.get("x-admin") === "true",
  roles: async (request) => (request.headers.get("x-roles") ?? "").split(",").filter(Boolean),
  activeOrganizationId: async (request) => request.headers.get("x-org") ?? undefined,
};

const opened: Array<{ events: EventsService; controllers: AbortController[] }> = [];

async function setup(eventIdentity?: EventIdentity): Promise<{
  events: EventsService;
  send: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const events = new EventsService(new MemoryEventBus(), new ReadinessService());
  await events.connect();
  const controllers: AbortController[] = [];
  opened.push({ events, controllers });
  const app = new Elysia()
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { code: "VALIDATION_ERROR" };
      }
      if (!(error instanceof AppException)) return undefined;
      set.status = error.statusCode;
      return { code: error.code };
    })
    .use(eventsRoutes(events, headerIdentity, eventIdentity));
  return {
    events,
    send: (path, init = {}) => {
      const controller = new AbortController();
      controllers.push(controller);
      return app.handle(new Request(`http://localhost${path}`, { ...init, signal: controller.signal }));
    },
  };
}

function publish(
  send: (path: string, init?: RequestInit) => Promise<Response>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return send("/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing body");
    this.reader = reader;
  }

  /** Reads until `text` arrives and returns everything received up to it. */
  async until(text: string): Promise<string> {
    while (!this.buffered.includes(text)) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`stream ended before ${text}`);
      this.buffered += this.decoder.decode(value, { stream: true });
    }
    const end = this.buffered.indexOf(text) + text.length;
    const seen = this.buffered.slice(0, end);
    this.buffered = this.buffered.slice(end);
    return seen;
  }
}

afterEach(async () => {
  for (const { events, controllers } of opened.splice(0)) {
    for (const controller of controllers) controller.abort();
    await events.close();
  }
});

describe("events routes", () => {
  it("requires a signed-in user to stream", async () => {
    const { send } = await setup();
    const response = await send("/events/stream");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "AUTH_REQUIRED" });
  });

  it("rejects malformed topic lists", async () => {
    const { send } = await setup();
    for (const topics of ["", "a b", Array.from({ length: 33 }, (_, i) => `t${i}`).join(",")]) {
      const response = await send(`/events/stream?topics=${encodeURIComponent(topics)}`, {
        headers: { "x-user": "alice" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "EVENTS_TOPICS_INVALID" });
    }
  });

  it("refuses a guarded topic the user may not read", async () => {
    const { events, send } = await setup();
    events.topics.register("ops", (subscriber) => subscriber.roles.includes("admin"));
    const denied = await send("/events/stream?topics=ops", { headers: { "x-user": "alice" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: "EVENTS_TOPIC_FORBIDDEN" });
    const allowed = await send("/events/stream?topics=ops", {
      headers: { "x-user": "root", "x-admin": "true", "x-roles": "admin" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/event-stream");
  });

  it("lets only administrators publish", async () => {
    const { send } = await setup();
    const anonymous = await publish(send, {}, { message: "hi" });
    expect(anonymous.status).toBe(401);
    const member = await publish(send, { "x-user": "alice" }, { message: "hi" });
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ code: "ADMIN_REQUIRED" });
    const admin = await publish(send, { "x-user": "root", "x-admin": "true" }, { message: "hi" });
    expect(admin.status).toBe(201);
    expect(await admin.json()).toEqual({ ok: true });
  });

  it("rejects an empty or unknown audience field", async () => {
    const { send } = await setup();
    const admin = { "x-user": "root", "x-admin": "true" };
    expect((await publish(send, admin, { message: "x", audience: {} })).status).toBe(400);
    expect((await publish(send, admin, { message: "x", audience: { team: "a" } })).status).toBe(400);
    expect((await publish(send, admin, { message: "x", topic: "bad topic" })).status).toBe(400);
  });

  it("delivers an admin publish only to the addressed user", async () => {
    const { send } = await setup();
    const alice = new SseReader(await send("/events/stream?topics=notes", { headers: { "x-user": "alice" } }));
    const bob = new SseReader(await send("/events/stream?topics=notes", { headers: { "x-user": "bob" } }));
    expect(await alice.until("\n\n")).toBe("retry: 3000\n\n");
    expect(await bob.until("\n\n")).toBe("retry: 3000\n\n");
    const admin = { "x-user": "root", "x-admin": "true" };

    await publish(send, admin, { topic: "notes", audience: { userIds: ["alice"] }, message: "secret" });
    await publish(send, admin, { topic: "notes", message: "everyone" });

    expect(await alice.until("everyone\"}}\n\n")).toBe(
      'id: 1\ndata: {"topic":"notes","data":{"message":"secret"}}\n\n' +
        'id: 2\ndata: {"topic":"notes","data":{"message":"everyone"}}\n\n',
    );
    expect(await bob.until("everyone")).not.toContain("secret");
  });

  it("matches roles and organizations from a registered event identity", async () => {
    const identity: EventIdentity = {
      subscriber: async (request) => {
        const userId = request.headers.get("x-user");
        if (!userId) return undefined;
        return { userId, roles: ["member"], organizationId: request.headers.get("x-org") ?? undefined };
      },
    };
    const { send } = await setup(identity);
    const inside = new SseReader(await send("/events/stream?topics=org", {
      headers: { "x-user": "a", "x-org": "o1" },
    }));
    const outside = new SseReader(await send("/events/stream?topics=org", {
      headers: { "x-user": "b", "x-org": "o2" },
    }));
    const admin = { "x-user": "root", "x-admin": "true" };

    await publish(send, admin, {
      topic: "org",
      audience: { organizationId: "o1", roles: ["member"] },
      message: "o1 only",
    });
    await publish(send, admin, { topic: "org", message: "done" });

    expect(await inside.until("done")).toContain("o1 only");
    expect(await outside.until("done")).not.toContain("o1 only");
  });
});

describe("default event identity", () => {
  it("carries the request roles and active organization", async () => {
    const identity = requestEventIdentity(headerIdentity);
    const request = new Request("http://localhost/events/stream", {
      headers: { "x-user": "u1", "x-roles": "admin,editor", "x-org": "org-1" },
    });
    expect(await identity.subscriber(request)).toEqual({ userId: "u1", roles: ["admin", "editor"], organizationId: "org-1" });
    expect(await identity.subscriber(new Request("http://localhost/events/stream", { headers: { "x-user": "u2" } })))
      .toEqual({ userId: "u2", roles: [] });
    expect(await identity.subscriber(new Request("http://localhost/events/stream"))).toBeUndefined();
  });
});

describe("events module", () => {
  it("ends open streams when the API starts shutting down", async () => {
    const services = new ServiceRegistry();
    const shutdown = new Shutdown();
    services.register(EVENTS, new MemoryEventBus());
    services.register(READINESS, new ReadinessService());
    services.register(SHUTDOWN, shutdown);
    eventsModule.configure?.(validateEnv({}), services);
    await services.start();
    try {
      const stream = await services.resolve(SSE_EVENTS).open(
        { userId: "u1", roles: [] },
        undefined,
        new AbortController().signal,
      );

      shutdown.begin();

      expect(stream.isClosed).toBe(true);
      expect(await stream.next()).toBeUndefined();
    } finally {
      await services.close();
    }
  });
});

describe("stream limit configuration", () => {
  it("reads SSE_MAX_STREAMS_PER_USER and defaults to eight", () => {
    expect(maxStreamsPerUser({})).toBe(8);
    expect(maxStreamsPerUser({ SSE_MAX_STREAMS_PER_USER: "3" })).toBe(3);
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(() => maxStreamsPerUser({ SSE_MAX_STREAMS_PER_USER: value })).toThrow(
        "SSE_MAX_STREAMS_PER_USER must be a positive integer",
      );
    }
  });

  it("answers 429 EVENTS_STREAM_LIMIT over HTTP", async () => {
    const events = new EventsService(new MemoryEventBus(), new ReadinessService(), {
      maxStreamsPerUser: 1,
    });
    await events.connect();
    const controllers: AbortController[] = [];
    opened.push({ events, controllers });
    const app = new Elysia()
      .onError(({ error, set }) => {
        if (!(error instanceof AppException)) return undefined;
        set.status = error.statusCode;
        return { code: error.code };
      })
      .use(eventsRoutes(events, headerIdentity));
    const send = (): Promise<Response> => {
      const controller = new AbortController();
      controllers.push(controller);
      return app.handle(
        new Request("http://localhost/events/stream", {
          headers: { "x-user": "u1" },
          signal: controller.signal,
        }),
      );
    };
    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ code: "EVENTS_STREAM_LIMIT" });
  });
});
