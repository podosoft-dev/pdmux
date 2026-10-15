import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import { MemoryEventBus } from "@podosoft/podokit-runtime";
import { ReadinessService } from "../health/readiness.service";
import { InvalidEventError, type EventSubscriber } from "./event-envelope";
import {
  encodeFrame,
  eventStreamResponse,
  type EventStream,
  type Scheduler,
  type StreamFrame,
} from "./event-stream";
import { EventsService, type EventsServiceOptions } from "./events.service";

interface FakeScheduler extends Scheduler {
  active(): number;
  tick(): void;
}

function fakeScheduler(): FakeScheduler {
  const tasks = new Set<() => void>();
  return {
    every: (_intervalMs, task) => {
      const entry = (): void => task();
      tasks.add(entry);
      return () => {
        tasks.delete(entry);
      };
    },
    active: () => tasks.size,
    tick: () => {
      for (const task of [...tasks]) task();
    },
  };
}

function user(userId: string, roles: string[] = [], organizationId?: string): EventSubscriber {
  return { userId, roles, ...(organizationId ? { organizationId } : {}) };
}

const services: EventsService[] = [];

async function service(
  options: EventsServiceOptions = {},
  bus = new MemoryEventBus(),
): Promise<EventsService> {
  const events = new EventsService(bus, new ReadinessService(), {
    scheduler: fakeScheduler(),
    ...options,
  });
  await events.connect();
  services.push(events);
  return events;
}

function open(
  events: EventsService,
  subscriber: EventSubscriber,
  topics?: string[],
): Promise<EventStream> {
  return events.open(subscriber, topics, new AbortController().signal);
}

function decoded(frame: StreamFrame | undefined): unknown {
  return frame?.kind === "event" ? JSON.parse(frame.data) : frame;
}

/** Publishes a broadcast marker and returns every frame the stream saw before it. */
async function framesBefore(
  events: EventsService,
  stream: EventStream,
  topic = "marker",
): Promise<unknown[]> {
  const marker = `marker-${Math.random()}`;
  await events.publishAsync({ topic, data: marker });
  const frames: unknown[] = [];
  for (;;) {
    const frame = await stream.next();
    const value = decoded(frame);
    if (frame?.kind === "event" && (value as { topic: unknown }).topic === topic) {
      if ((value as { data: unknown }).data === marker) return frames;
      continue;
    }
    frames.push(value);
  }
}

afterEach(async () => {
  for (const events of services.splice(0)) await events.close();
});

describe("EventsService", () => {
  it("publishes through the transport and delivers to a subscribed stream", async () => {
    const readiness = new ReadinessService();
    const events = new EventsService(new MemoryEventBus(), readiness, { scheduler: fakeScheduler() });
    services.push(events);
    await events.connect();
    const stream = await open(events, user("a"), ["changes"]);

    await events.publishAsync({ topic: "changes", data: { type: "changed" } });

    expect(await stream.next()).toEqual({
      kind: "event",
      id: "1",
      data: JSON.stringify({ topic: "changes", data: { type: "changed" } }),
    });
    await expect(readiness.run()).resolves.toEqual({ events: "up" });
  });

  it("rejects events larger than the configured limit", async () => {
    const events = await service({}, new MemoryEventBus({ maxEventBytes: 8 }));
    await expect(events.publishAsync({ topic: "t", data: "too large" })).rejects.toThrow(
      "Event exceeds maxEventBytes",
    );
  });

  it("rejects invalid topics, ids, and empty audiences", async () => {
    const events = await service();
    await expect(events.publishAsync({ topic: "bad topic", data: 1 })).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await expect(events.publishAsync({ topic: "t", id: "a\nb", data: 1 })).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await expect(events.publishAsync({ topic: "t", audience: {}, data: 1 })).rejects.toThrow(
      "audience must set userIds, roles, or organizationId",
    );
    expect(() => events.publish({ topic: "", data: 1 })).toThrow(InvalidEventError);
  });

  it("uses a given event id instead of the connection sequence", async () => {
    const events = await service();
    const stream = await open(events, user("a"), ["t"]);
    await events.publishAsync({ topic: "t", id: "job-1:40", data: 40 });
    expect(await stream.next()).toMatchObject({ kind: "event", id: "job-1:40" });
  });
});

describe("audience filtering", () => {
  it("delivers a user audience only to that user", async () => {
    const events = await service();
    const alice = await open(events, user("alice"), ["orders", "marker"]);
    const bob = await open(events, user("bob"), ["orders", "marker"]);

    await events.publishAsync({ topic: "orders", audience: { userIds: ["bob"] }, data: "bob's" });

    expect(await framesBefore(events, alice)).toEqual([]);
    expect(await framesBefore(events, bob)).toEqual([{ topic: "orders", data: "bob's" }]);
  });

  it("delivers a role audience to users holding any listed role", async () => {
    const events = await service();
    const admin = await open(events, user("root", ["user", "admin"]), ["ops", "marker"]);
    const member = await open(events, user("member", ["user"]), ["ops", "marker"]);

    await events.publishAsync({ topic: "ops", audience: { roles: ["admin", "auditor"] }, data: 1 });

    expect(await framesBefore(events, admin)).toEqual([{ topic: "ops", data: 1 }]);
    expect(await framesBefore(events, member)).toEqual([]);
  });

  it("requires every audience field to match", async () => {
    const events = await service();
    const orgAdmin = await open(events, user("a", ["admin"], "org-1"), ["t", "marker"]);
    const otherOrgAdmin = await open(events, user("b", ["admin"], "org-2"), ["t", "marker"]);
    const orgMember = await open(events, user("c", [], "org-1"), ["t", "marker"]);

    await events.publishAsync({
      topic: "t",
      audience: { organizationId: "org-1", roles: ["admin"] },
      data: "org-1 admins",
    });

    expect(await framesBefore(events, orgAdmin)).toEqual([{ topic: "t", data: "org-1 admins" }]);
    expect(await framesBefore(events, otherOrgAdmin)).toEqual([]);
    expect(await framesBefore(events, orgMember)).toEqual([]);
  });

  it("delivers an empty recipient list to nobody", async () => {
    const events = await service();
    const stream = await open(events, user("a"), ["t", "marker"]);
    await events.publishAsync({ topic: "t", audience: { userIds: [] }, data: 1 });
    expect(await framesBefore(events, stream)).toEqual([]);
  });

  it("filters on every replica that shares the transport", async () => {
    const bus = new MemoryEventBus();
    const publisher = await service({}, bus);
    const replica = await service({}, bus);
    const alice = await open(replica, user("alice"), ["t", "marker"]);
    const bob = await open(replica, user("bob"), ["t", "marker"]);

    await publisher.publishAsync({ topic: "t", audience: { userIds: ["alice"] }, data: "hi" });

    expect(await framesBefore(publisher, alice)).toEqual([{ topic: "t", data: "hi" }]);
    expect(await framesBefore(publisher, bob)).toEqual([]);
  });

  it("discards malformed transport messages", async () => {
    const bus = new MemoryEventBus();
    const events = await service({}, bus);
    const stream = await open(events, user("a"));
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bus.publish("sse", { type: "message", message: "legacy" });
      await bus.publish("sse", { topic: "t", audience: { userIds: "a" }, data: 1 });
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
      stderr.mockRestore();
    }
    expect(await framesBefore(events, stream)).toEqual([]);
  });
});

describe("topic filtering", () => {
  it("delivers only subscribed topics", async () => {
    const events = await service();
    const stream = await open(events, user("a"), ["a", "marker"]);
    await events.publishAsync({ topic: "b", data: "b" });
    await events.publishAsync({ topic: "a", data: "a" });
    expect(await framesBefore(events, stream)).toEqual([{ topic: "a", data: "a" }]);
  });

  it("gives a stream without topics every topic except guarded ones", async () => {
    const events = await service();
    events.topics.register("admin-alerts", (subscriber) => subscriber.roles.includes("admin"));
    const stream = await open(events, user("root", ["admin"]));
    await events.publishAsync({ topic: "admin-alerts", data: "guarded" });
    await events.publishAsync({ topic: "news", data: "open" });
    expect(await framesBefore(events, stream)).toEqual([{ topic: "news", data: "open" }]);
  });

  it("lets authorizers restrict who may subscribe", async () => {
    const events = await service();
    events.topics.register("admin-alerts", (subscriber) => subscriber.roles.includes("admin"));
    events.topics.register("project:*", (subscriber, topic) =>
      topic === `project:${subscriber.organizationId}`
    );

    const denied = open(events, user("member"), ["admin-alerts"]);
    await expect(denied).rejects.toBeInstanceOf(AppException);
    await expect(denied).rejects.toMatchObject({ code: "EVENTS_TOPIC_FORBIDDEN", statusCode: 403 });
    await expect(open(events, user("a", [], "p1"), ["project:p2"])).rejects.toMatchObject({
      statusCode: 403,
    });

    const admin = await open(events, user("root", ["admin"]), ["admin-alerts", "marker"]);
    const project = await open(events, user("a", [], "p1"), ["project:p1", "marker"]);
    await events.publishAsync({ topic: "admin-alerts", data: "alert" });
    await events.publishAsync({ topic: "project:p1", data: "update" });
    expect(await framesBefore(events, admin)).toEqual([{ topic: "admin-alerts", data: "alert" }]);
    expect(await framesBefore(events, project)).toEqual([{ topic: "project:p1", data: "update" }]);
    expect(events.streamCount).toBe(2);
  });
});

describe("per-connection safety", () => {
  it("drops the backlog of a slow client and sends one resync", async () => {
    const events = await service({ queueLimit: 3 });
    const stream = await open(events, user("a"), ["t"]);
    for (let index = 1; index <= 5; index += 1) {
      await events.publishAsync({ topic: "t", data: index });
    }

    expect(await stream.next()).toEqual({ kind: "resync" });
    expect(decoded(await stream.next())).toEqual({ topic: "t", data: 5 });
    await events.publishAsync({ topic: "t", data: 6 });
    expect(decoded(await stream.next())).toEqual({ topic: "t", data: 6 });
  });

  it("reuses one heartbeat timer per connection and releases it on disconnect", async () => {
    const scheduler = fakeScheduler();
    const events = await service({ scheduler });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const streams = await Promise.all(
      controllers.map((controller, index) =>
        events.open(user(`u${index}`), ["t"], controller.signal)
      ),
    );
    expect(scheduler.active()).toBe(3);

    for (let index = 0; index < 1_000; index += 1) {
      await events.publishAsync({ topic: "t", data: index });
      for (const stream of streams) await stream.next();
    }
    expect(scheduler.active()).toBe(3);

    scheduler.tick();
    const first = streams[0];
    if (!first) throw new Error("missing stream");
    expect(await first.next()).toEqual({ kind: "heartbeat" });
    expect(scheduler.active()).toBe(3);

    for (const controller of controllers) controller.abort();
    expect(scheduler.active()).toBe(0);
    expect(events.streamCount).toBe(0);
  });

  it("wakes a waiting stream on abort and detaches it immediately", async () => {
    const scheduler = fakeScheduler();
    const events = await service({ scheduler });
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    const stream = await events.open(user("a"), ["t"], controller.signal);
    const waiting = stream.next();

    controller.abort();

    expect(await waiting).toBeUndefined();
    expect(stream.isClosed).toBe(true);
    expect(events.streamCount).toBe(0);
    expect(scheduler.active()).toBe(0);
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    await events.publishAsync({ topic: "t", data: "late" });
    expect(await stream.next()).toBeUndefined();
  });

  it("closes a stream opened with an already aborted signal", async () => {
    const scheduler = fakeScheduler();
    const events = await service({ scheduler });
    const controller = new AbortController();
    controller.abort();
    const stream = await events.open(user("a"), ["t"], controller.signal);
    expect(await stream.next()).toBeUndefined();
    expect(events.streamCount).toBe(0);
    expect(scheduler.active()).toBe(0);
  });

  it("ends streams after the maximum connection time", async () => {
    const scheduler = fakeScheduler();
    let now = 0;
    const events = await service({ scheduler, maxConnectionMs: 60_000, now: () => now });
    const stream = await open(events, user("a"), ["t"]);
    now = 59_999;
    scheduler.tick();
    expect(await stream.next()).toEqual({ kind: "heartbeat" });
    now = 60_000;
    scheduler.tick();
    expect(await stream.next()).toBeUndefined();
    expect(events.streamCount).toBe(0);
    expect(scheduler.active()).toBe(0);
  });

  it("closes every stream when the service closes", async () => {
    const scheduler = fakeScheduler();
    const events = await service({ scheduler });
    const stream = await open(events, user("a"));
    await events.close();
    expect(await stream.next()).toBeUndefined();
    expect(scheduler.active()).toBe(0);
  });
});

describe("SSE wire format", () => {
  it("encodes data events as default messages and control frames separately", () => {
    expect(encodeFrame({ kind: "event", id: "7", data: '{"topic":"t","data":1}' })).toBe(
      'id: 7\ndata: {"topic":"t","data":1}\n\n',
    );
    expect(encodeFrame({ kind: "resync" })).toBe("event: resync\ndata: {}\n\n");
    expect(encodeFrame({ kind: "heartbeat" })).toBe(": heartbeat\n\n");
  });

  it("streams a retry hint first and releases the stream when the body is cancelled", async () => {
    const events = await service({ retryMs: 1_500 });
    const stream = await open(events, user("a"), ["t"]);
    const response = eventStreamResponse(stream, events.retryMs);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing body");
    const decoder = new TextDecoder();

    expect(decoder.decode((await reader.read()).value)).toBe("retry: 1500\n\n");
    await events.publishAsync({ topic: "t", data: "line\nbreak" });
    expect(decoder.decode((await reader.read()).value)).toBe(
      'id: 1\ndata: {"topic":"t","data":"line\\nbreak"}\n\n',
    );

    await reader.cancel();
    expect(stream.isClosed).toBe(true);
    expect(events.streamCount).toBe(0);
  });
});
