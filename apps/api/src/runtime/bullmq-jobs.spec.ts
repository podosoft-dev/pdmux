import { describe, expect, it } from "bun:test";
import type { ConnectionOptions } from "bullmq";
import { ServiceRegistry, READINESS } from "../core/services";
import { ReadinessService } from "../health/readiness.service";
import { producerConnection } from "../jobs/queue";
import {
  BullMqJobProvider,
  MAINTENANCE_JOBS_CHECK,
  superviseBullMqJobs,
  type ScheduleQueueFactory,
} from "./jobs";

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

/** Answers the connection handshake and INFO like Redis 7, and can drop every connection. */
function fakeRedis(): { port: number; drop: () => void; stop: () => void } {
  const info = "# Server\r\nredis_version:7.2.0\r\nloading:0\r\n";
  const sockets = new Set<{ end: () => void }>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
      data(socket, data) {
        // Each command is an array of bulk strings: "*<count>", "$<length>", "<name>", ...
        const lines = data.toString().split("\r\n");
        lines.forEach((line, index) => {
          if (!line.startsWith("*")) return;
          const command = lines[index + 2]?.toLowerCase();
          if (command === "info") socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
          else socket.write("+OK\r\n");
        });
      },
    },
  });
  return {
    port: server.port,
    drop: () => { for (const socket of [...sockets]) socket.end(); },
    stop: () => server.stop(true),
  };
}

interface Added { queue: string; name: string; options: unknown }

function recordingQueues(fail: () => Error | undefined = () => undefined): {
  added: Added[];
  factory: ScheduleQueueFactory;
} {
  const added: Added[] = [];
  const factory: ScheduleQueueFactory = (queue) => ({
    add: (name: string, _data: unknown, options: unknown) => {
      const error = fail();
      if (error) return Promise.reject(error);
      added.push({ queue, name, options });
      return Promise.resolve({ id: "repeat" }) as never;
    },
    close: () => Promise.resolve(),
  });
  return { added, factory };
}

function scheduleBoth(jobs: BullMqJobProvider): void {
  jobs.repeat("stale-hosts", "remove-stale-hosts", {}, { id: "remove-stale-hosts", cron: "43 4 * * *", intervalMs: 86_400_000 });
  jobs.repeat("metrics-retention", "prune-metric-samples", {}, { id: "prune-metric-samples", cron: "17 * * * *", intervalMs: 3_600_000 });
}

async function until(condition: () => boolean, limitMs = 2_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(10);
  }
}

describe("[TC-PDHOST-035] maintenance schedules over a supervised Redis connection", () => {
  it("lets the registry start and reports the check down while Redis refuses connections", async () => {
    const services = new ServiceRegistry();
    const readiness = new ReadinessService({ cacheMs: 0 });
    services.register(READINESS, readiness);
    const { added, factory } = recordingQueues();
    const jobs = superviseBullMqJobs(services, new BullMqJobProvider(producerAt(closedPort()), factory));
    try {
      const started = Date.now();
      scheduleBoth(jobs);
      await services.start();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(added).toEqual([]);
      expect(await readiness.run()).toEqual({ [MAINTENANCE_JOBS_CHECK]: "down" });
      await expect(jobs.ready()).rejects.toThrow("not scheduled");
    } finally {
      await services.close();
      await jobs.close();
    }
  });

  it("applies every schedule once Redis answers and again after the connection drops", async () => {
    const redis = fakeRedis();
    const { added, factory } = recordingQueues();
    const jobs = new BullMqJobProvider(producerAt(redis.port), factory);
    const lost: unknown[] = [];
    jobs.onLost((reason) => { lost.push(reason); });
    try {
      scheduleBoth(jobs);
      await jobs.connect();
      await jobs.ready();
      expect(added).toEqual([
        {
          queue: "stale-hosts",
          name: "remove-stale-hosts",
          options: { repeat: { pattern: "43 4 * * *" }, jobId: "remove-stale-hosts", removeOnComplete: true, removeOnFail: 20 },
        },
        {
          queue: "metrics-retention",
          name: "prune-metric-samples",
          options: { repeat: { pattern: "17 * * * *" }, jobId: "prune-metric-samples", removeOnComplete: true, removeOnFail: 20 },
        },
      ]);

      redis.drop();
      await until(() => lost.length > 0);
      await expect(jobs.ready()).rejects.toThrow("not scheduled");
      await jobs.connect();
      await jobs.ready();
      expect(added.map((entry) => entry.name)).toEqual([
        "remove-stale-hosts", "prune-metric-samples", "remove-stale-hosts", "prune-metric-samples",
      ]);
    } finally {
      await jobs.close();
      redis.stop();
    }
  });

  it("fails an attempt whose schedule Redis does not confirm, and retries on a new connection", async () => {
    const redis = fakeRedis();
    let failures = 1;
    const { added, factory } = recordingQueues(() => failures-- > 0 ? new Error("Command timed out") : undefined);
    const jobs = new BullMqJobProvider(producerAt(redis.port), factory);
    try {
      scheduleBoth(jobs);
      await expect(jobs.connect()).rejects.toThrow("Command timed out");
      await expect(jobs.ready()).rejects.toThrow("not scheduled");
      await jobs.connect();
      await jobs.ready();
      expect(added.map((entry) => entry.name)).toEqual(["remove-stale-hosts", "prune-metric-samples"]);
    } finally {
      await jobs.close();
      redis.stop();
    }
  });

  it("applies a schedule declared after connecting without waiting for a reconnect", async () => {
    const redis = fakeRedis();
    const { added, factory } = recordingQueues();
    const jobs = new BullMqJobProvider(producerAt(redis.port), factory);
    try {
      await jobs.connect();
      scheduleBoth(jobs);
      await until(() => added.length === 2);
      await jobs.ready();
    } finally {
      await jobs.close();
      redis.stop();
    }
  });
});
