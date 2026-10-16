import { describe, expect, it } from "bun:test";
import type { ConnectionOptions } from "bullmq";
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
