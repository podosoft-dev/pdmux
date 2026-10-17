import { describe, expect, it } from "bun:test";
import { Queue, type ConnectionOptions } from "bullmq";
import { BullMqJobQueue, externalJobId, parseExternalJobId } from "./bullmq-job.queue";
import { producerConnection, reconnectDelay, redisConnection } from "./queue";

function producerAt(port: number): ConnectionOptions {
  return producerConnection({
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(port),
    REDIS_COMMAND_TIMEOUT_MS: "100",
  });
}

function closedPort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/**
 * Answers the connection handshake and INFO like Redis 7, but stops answering a
 * connection, without closing it, once it sends any other command.
 */
function stallingRedis(): { port: number; stop: () => void } {
  const info = "# Server\r\nredis_version:7.2.0\r\nloading:0\r\n";
  const stalled = new WeakSet<object>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        // Each command is an array of bulk strings: "*<count>", "$<length>", "<name>", ...
        const lines = data.toString().split("\r\n");
        lines.forEach((line, index) => {
          if (stalled.has(socket) || !line.startsWith("*")) return;
          const command = lines[index + 2]?.toLowerCase();
          if (command === "client") socket.write("+OK\r\n");
          else if (command === "info") socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
          else stalled.add(socket);
        });
      },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("BullMQ job identifiers", () => {
  it("round-trips queue names without exposing an ambiguous id", () => {
    const id = externalJobId("email/delivery", "42");
    expect(parseExternalJobId(id)).toEqual({ name: "email/delivery", id: "42" });
    expect(parseExternalJobId("invalid")).toBeNull();
  });
});

describe("BullMQ connections", () => {
  it("lets workers wait for replies and gives producers a bounded, supervised connection", () => {
    expect(redisConnection({})).toMatchObject({ maxRetriesPerRequest: null });
    const producer = producerConnection({ REDIS_COMMAND_TIMEOUT_MS: "750" });
    expect(producer).toMatchObject({ enableOfflineQueue: false, commandTimeout: 750, lazyConnect: true });
    expect("retryStrategy" in producer && producer.retryStrategy?.(1)).toBeNull();
  });

  it("backs off reconnects from 250 ms up to 5 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 30].map(reconnectDelay)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  });
});

describe("BullMqJobQueue while Redis is unavailable", () => {
  it("fails enqueues and reads at once before the producer has connected", async () => {
    const queue = new BullMqJobQueue(producerAt(closedPort()));
    try {
      const started = Date.now();
      expect(await rejection(queue.enqueue("demo", { text: "hello" })))
        .toMatchObject({ code: "JOBS_UNAVAILABLE", statusCode: 503 });
      expect(await rejection(queue.get(externalJobId("demo", "1"))))
        .toMatchObject({ code: "JOBS_UNAVAILABLE" });
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await queue.close();
    }
  });

  it("reports a refused connection to the supervisor and keeps failing enqueues at once", async () => {
    const queue = new BullMqJobQueue(producerAt(closedPort()));
    const lost: unknown[] = [];
    queue.onLost((reason) => { lost.push(reason); });
    try {
      await expect(queue.connect()).rejects.toThrow();
      await expect(queue.ready()).rejects.toMatchObject({ code: "JOBS_UNAVAILABLE" });
      const started = Date.now();
      expect(await rejection(queue.enqueue("demo", {}))).toMatchObject({ code: "JOBS_UNAVAILABLE" });
      expect(Date.now() - started).toBeLessThan(100);
      expect(lost.length).toBeGreaterThan(0);
    } finally {
      await queue.close();
    }
  });

  it("drops a connection Redis stops answering and fails at once until the supervisor reopens it", async () => {
    const redis = stallingRedis();
    const queue = new BullMqJobQueue(producerAt(redis.port));
    const lost: unknown[] = [];
    queue.onLost((reason) => { lost.push(reason); });
    try {
      await queue.connect();
      let started = Date.now();
      expect(await rejection(queue.enqueue("demo", { text: "hello" })))
        .toMatchObject({ code: "JOBS_UNAVAILABLE", statusCode: 503 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(lost.length).toBe(1);

      started = Date.now();
      expect(await rejection(queue.enqueue("demo", {}))).toMatchObject({ code: "JOBS_UNAVAILABLE" });
      expect(Date.now() - started).toBeLessThan(100);

      await queue.connect();
      await queue.ready();
      await Bun.sleep(50);
      expect(lost.length).toBe(1);
    } finally {
      await queue.close();
      redis.stop();
    }
  });
});

describe("BullMqJobQueue schedules", () => {
  it("rejects an invalid schedule before keeping it", async () => {
    const queue = new BullMqJobQueue(producerAt(closedPort()));
    try {
      await expect(queue.schedule("bad", "report", {}, { cron: "61 * * * *" })).rejects.toThrow();
      await expect(queue.schedule("bad", "report", {}, { cron: "0 3 * * *", timezone: "Mars/Olympus" })).rejects.toThrow();
      await expect(queue.schedule("bad", "report", {}, { everyMs: 10 })).rejects.toThrow("at least 1000");
      await expect(queue.schedule("bad", "report", {}, { everyMs: 1_000 }, { keepFailed: 1.5 })).rejects.toThrow(
        "keepFailed must be a whole number of at least 0",
      );
    } finally {
      await queue.close();
    }
  });

  it("keeps a schedule while Redis is unreachable instead of failing", async () => {
    const queue = new BullMqJobQueue(producerAt(closedPort()));
    try {
      await expect(queue.schedule("nightly", "report", {}, { cron: "0 3 * * *" })).resolves.toBeUndefined();
      await expect(queue.unschedule("nightly")).resolves.toBeUndefined();
    } finally {
      await queue.close();
    }
  });
});

// Runs against the Redis the app's environment names (REDIS_URL or REDIS_HOST, as
// in .env); skipped when neither is set.
describe.skipIf(!process.env.REDIS_URL && !process.env.REDIS_HOST)("BullMqJobQueue schedules in Redis", () => {
  const REDIS = process.env;
  it("applies schedules on connect, again after Redis lost them, and removes them", async () => {
    const name = `schedule-test-${crypto.randomUUID()}`;
    const queue = new BullMqJobQueue(producerConnection(REDIS));
    const inspect = new Queue(name, { connection: redisConnection(REDIS) });
    try {
      await queue.schedule("hourly", name, { scope: "all" }, { everyMs: 3_600_000 });
      await queue.schedule("nightly", name, {}, { cron: "0 3 * * *", timezone: "Asia/Seoul" });
      expect(await inspect.getJobScheduler("hourly")).toBeUndefined();

      await queue.connect();
      expect(await inspect.getJobScheduler("hourly")).toMatchObject({ every: 3_600_000, name });
      expect(await inspect.getJobScheduler("nightly")).toMatchObject({ pattern: "0 3 * * *", tz: "Asia/Seoul" });

      // A Redis that lost its data gets the schedules back on the next connect.
      await inspect.removeJobScheduler("hourly");
      await queue.connect();
      expect(await inspect.getJobScheduler("hourly")).toMatchObject({ every: 3_600_000 });

      await queue.unschedule("nightly");
      expect(await inspect.getJobScheduler("nightly")).toBeUndefined();
      expect(await inspect.getJobSchedulersCount()).toBe(1);
    } finally {
      await queue.close();
      await inspect.obliterate({ force: true });
      await inspect.close();
    }
  });

  it("limits the finished jobs a schedule's runs leave, 100 completed and 1000 failed by default", async () => {
    const name = `schedule-test-${crypto.randomUUID()}`;
    const queue = new BullMqJobQueue(producerConnection(REDIS));
    const inspect = new Queue(name, { connection: redisConnection(REDIS) });
    try {
      await queue.connect();
      await queue.schedule("default", name, {}, { cron: "0 3 * * *" });
      await queue.schedule("custom", name, {}, { everyMs: 3_600_000 }, { keepCompleted: 0, keepFailed: 20 });
      expect((await inspect.getJobScheduler("default"))?.template?.opts).toMatchObject({
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 1_000 },
      });
      expect((await inspect.getJobScheduler("custom"))?.template?.opts).toMatchObject({
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 20 },
      });
    } finally {
      await queue.close();
      await inspect.obliterate({ force: true });
      await inspect.close();
    }
  });

  it("removes finished runs beyond the schedule's limits", async () => {
    const name = `schedule-test-${crypto.randomUUID()}`;
    const queue = new BullMqJobQueue(producerConnection(REDIS));
    const inspect = new Queue(name, { connection: redisConnection(REDIS) });
    let runs = 0;
    try {
      await queue.connect();
      await queue.process(name, () => {
        runs += 1;
        if (runs % 2 === 0) throw new Error("expected failure");
      });
      await queue.schedule("tick", name, {}, { everyMs: 1_000 }, { keepCompleted: 1, keepFailed: 1 });
      for (let waited = 0; runs < 4 && waited < 10_000; waited += 100) await Bun.sleep(100);
      expect(runs).toBeGreaterThanOrEqual(4);
      // The last run's job moves to its finished set just after the handler returns.
      await Bun.sleep(200);
      expect(await inspect.getJobCounts("completed", "failed")).toEqual({ completed: 1, failed: 1 });
    } finally {
      await queue.close();
      await inspect.obliterate({ force: true });
      await inspect.close();
    }
  }, 15_000);
});
