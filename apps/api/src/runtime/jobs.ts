import { Queue, RedisConnection, type ConnectionOptions, type RedisClient } from "bullmq";
import { READINESS, type ServiceRegistry, type SupervisedConnection } from "../core/services";
import { producerConnection } from "../jobs/queue";

import type { JobProvider, RepeatJobOptions } from "./local-jobs";
export * from "./local-jobs";

/** Names the supervised connection and the readiness check of the maintenance schedules. */
export const MAINTENANCE_JOBS_CHECK = "pdmux-maintenance";

// BullMQ would otherwise wait for Redis and ask its version before the first
// command, which keeps a call pending while Redis is down instead of failing it.
const NO_STARTUP_ROUND_TRIP = { skipWaitingForReady: true, skipVersionCheck: true } as const;

interface Schedule {
  queue: string;
  name: string;
  data: Record<string, unknown>;
  options: RepeatJobOptions;
}

export type ScheduleQueue = Pick<Queue, "add" | "close">;
export type ScheduleQueueFactory = (name: string, client: RedisClient) => ScheduleQueue;

const bullMqQueue: ScheduleQueueFactory = (name, client) => {
  const queue = new Queue(name, { connection: client, ...NO_STARTUP_ROUND_TRIP });
  // It reports the producer connection's errors, which the provider already handles.
  queue.on("error", () => undefined);
  return queue;
};

function isReplyTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Command timed out";
}

/**
 * Schedules the maintenance jobs as BullMQ repeats; the worker process runs
 * them. Like PodoKit's job queue it uses one producer connection that the
 * service registry supervises: commands fail at once while Redis is down and
 * wait at most `REDIS_COMMAND_TIMEOUT_MS` for a reply, so the API listens
 * without Redis. Every connect applies all schedules again. That is idempotent,
 * because a repeat is keyed by its job id and pattern, and it restores the
 * schedules after Redis restarts without its data.
 */
export class BullMqJobProvider implements JobProvider, SupervisedConnection {
  private readonly schedules = new Map<string, Schedule>();
  private producer: RedisConnection;
  private scheduled = false;
  private lostListener?: (reason: unknown) => void;
  private closed = false;

  constructor(
    private readonly connection: ConnectionOptions = producerConnection(),
    private readonly createQueue: ScheduleQueueFactory = bullMqQueue,
  ) {
    this.producer = this.openProducer();
  }

  onLost(listener: (reason: unknown) => void): void {
    this.lostListener = listener;
  }

  /** Opens the producer connection and applies every schedule. */
  async connect(): Promise<void> {
    if (this.closed) return;
    const producer = this.producer;
    const client = await producer.client;
    if (client.status !== "ready") await client.connect();
    try {
      await this.apply(client, [...this.schedules.values()]);
    } catch (error: unknown) {
      // A reply that timed out would hold back every later command on this
      // connection, so the next attempt starts on a new one.
      if (producer === this.producer) this.replaceProducer();
      throw error;
    }
    if (producer === this.producer && !this.closed) this.scheduled = true;
  }

  /** Rejects until every schedule is applied, and while Redis does not answer in time. */
  async ready(): Promise<void> {
    if (!this.scheduled) throw new Error("The maintenance jobs are not scheduled");
    const producer = this.producer;
    const client = await producer.client;
    try {
      await client.info();
    } catch (error: unknown) {
      if (isReplyTimeout(error) && producer === this.producer) this.lose(error);
      throw error;
    }
  }

  /** The worker process runs the jobs. */
  register(): void {}

  repeat(queue: string, name: string, data: Record<string, unknown>, options: RepeatJobOptions): void {
    const schedule: Schedule = { queue, name, data, options };
    this.schedules.set(options.id, schedule);
    // Otherwise the next connect applies it.
    if (this.scheduled) void this.applyLater(schedule);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.scheduled = false;
    await this.producer.close(true);
  }

  private async apply(client: RedisClient, schedules: Schedule[]): Promise<void> {
    for (const { queue: queueName, name, data, options } of schedules) {
      const queue = this.createQueue(queueName, client);
      try {
        await queue.add(name, data, {
          repeat: { pattern: options.cron },
          jobId: options.id,
          removeOnComplete: true,
          removeOnFail: 20,
        });
      } finally {
        void queue.close().catch(() => undefined);
      }
    }
  }

  private async applyLater(schedule: Schedule): Promise<void> {
    const producer = this.producer;
    try {
      await this.apply(await producer.client, [schedule]);
    } catch (error: unknown) {
      // The supervisor reconnects, which applies every schedule again.
      if (producer === this.producer) this.lose(error);
    }
  }

  private openProducer(): RedisConnection {
    const producer = new RedisConnection(this.connection, {
      shared: false,
      blocking: false,
      ...NO_STARTUP_ROUND_TRIP,
    });
    // Connection errors reach the supervisor's log through `connect` and `onLost`.
    producer.on("error", () => undefined);
    producer.on("close", () => {
      if (producer === this.producer) this.lose(new Error("Connection closed"));
    });
    return producer;
  }

  private replaceProducer(): void {
    const stale = this.producer;
    this.scheduled = false;
    this.producer = this.openProducer();
    void stale.close(true).catch(() => undefined);
  }

  private lose(reason: unknown): void {
    if (this.closed) return;
    this.replaceProducer();
    this.lostListener?.(reason);
  }
}

/**
 * The BullMQ provider under the registry's supervision, reported as the
 * `pdmux-maintenance` readiness check.
 */
export function superviseBullMqJobs(
  services: ServiceRegistry,
  jobs: BullMqJobProvider = new BullMqJobProvider(),
): BullMqJobProvider {
  services.supervise(MAINTENANCE_JOBS_CHECK, jobs);
  services.resolve(READINESS).register(MAINTENANCE_JOBS_CHECK, () => jobs.ready());
  return jobs;
}
