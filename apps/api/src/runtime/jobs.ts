import { Queue, RedisConnection, type ConnectionOptions, type RedisClient } from "bullmq";
import { READINESS, type ServiceRegistry, type SupervisedConnection } from "../core/services";
import { producerConnection } from "../jobs/queue";

export type JobState = "waiting" | "active" | "completed" | "failed" | string;

export interface JobInput {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

export interface JobSnapshot {
  id: string;
  state: JobState;
  result: unknown;
}

export type JobProcessor = (job: JobInput) => unknown | Promise<unknown>;

export interface RepeatJobOptions {
  id: string;
  cron: string;
  intervalMs: number;
}

/** Runs pdmux's maintenance jobs on a schedule. */
export interface JobProvider {
  /** Runs `processor` for the named job in this process, where the provider runs jobs itself. */
  register(queue: string, name: string, processor: JobProcessor): void;
  /** Schedules the job. It returns at once and never waits for the provider's backend. */
  repeat(queue: string, name: string, data: Record<string, unknown>, options: RepeatJobOptions): void;
  close(): Promise<void>;
}

interface LocalJob extends JobSnapshot {
  data: Record<string, unknown>;
  name: string;
}

function processorKey(queue: string, name: string): string {
  return `${queue}:${name}`;
}

export class LocalJobProvider implements JobProvider {
  private readonly jobs = new Map<string, LocalJob>();
  private readonly processors = new Map<string, JobProcessor>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private closed = false;

  enqueue(queue: string, name: string, data: Record<string, unknown>): Promise<JobSnapshot> {
    if (this.closed) return Promise.reject(new Error("Local job provider is closed"));
    const id = crypto.randomUUID();
    const job: LocalJob = { id, name, data, state: "waiting", result: null };
    this.jobs.set(`${queue}:${id}`, job);
    queueMicrotask(() => { void this.process(queue, job); });
    return Promise.resolve(this.snapshot(job));
  }

  get(queue: string, id: string): Promise<JobSnapshot | null> {
    const job = this.jobs.get(`${queue}:${id}`);
    return Promise.resolve(job ? this.snapshot(job) : null);
  }

  register(queue: string, name: string, processor: JobProcessor): void {
    this.processors.set(processorKey(queue, name), processor);
  }

  repeat(queue: string, name: string, data: Record<string, unknown>, options: RepeatJobOptions): void {
    if (this.timers.has(options.id)) return;
    const timer = setInterval(() => { void this.enqueue(queue, name, data); }, options.intervalMs);
    timer.unref?.();
    this.timers.set(options.id, timer);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    return Promise.resolve();
  }

  private async process(queue: string, job: LocalJob): Promise<void> {
    const processor = this.processors.get(processorKey(queue, job.name));
    if (!processor) {
      job.state = "failed";
      job.result = { error: `No local processor is registered for ${queue}:${job.name}` };
      return;
    }
    job.state = "active";
    try {
      job.result = await processor({ id: job.id, name: job.name, data: job.data });
      job.state = "completed";
    } catch (error) {
      job.result = { error: error instanceof Error ? error.message : String(error) };
      job.state = "failed";
    }
  }

  private snapshot(job: LocalJob): JobSnapshot {
    return { id: job.id, state: job.state, result: job.result };
  }
}

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
