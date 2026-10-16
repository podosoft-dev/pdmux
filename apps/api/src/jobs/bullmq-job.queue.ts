import { AppException } from "@podosoft/podokit-contracts";
import { Queue, RedisConnection, Worker, type ConnectionOptions, type RedisClient } from "bullmq";
import type {
  EnqueueOptions,
  JobHandler,
  JobQueue,
  JobReference,
  JobSnapshot,
  JobStatus,
  Unsubscribe,
} from "@podosoft/podokit-runtime";
import type { SupervisedConnection } from "../core/services";
import { producerConnection, redisConnection } from "./queue";

const ID_SEPARATOR = "~";

// BullMQ would otherwise wait for Redis and ask its version before the first
// command, which keeps a call pending while Redis is down instead of failing it.
const NO_STARTUP_ROUND_TRIP = { skipWaitingForReady: true, skipVersionCheck: true } as const;

export function externalJobId(name: string, id: string): string {
  return `${encodeURIComponent(name)}${ID_SEPARATOR}${id}`;
}

export function parseExternalJobId(id: string): { name: string; id: string } | null {
  const separator = id.indexOf(ID_SEPARATOR);
  if (separator < 1 || separator === id.length - 1) return null;
  try {
    return { name: decodeURIComponent(id.slice(0, separator)), id: id.slice(separator + 1) };
  } catch {
    return null;
  }
}

function statusOf(state: string): JobStatus {
  if (state === "active" || state === "completed" || state === "failed") return state;
  return "waiting";
}

function isReplyTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Command timed out";
}

export function jobsUnavailable(): AppException {
  return new AppException("JOBS_UNAVAILABLE", "Background jobs are temporarily unavailable.", 503);
}

/**
 * Adds and reads jobs over one producer connection that the service registry
 * supervises, and runs in-process handlers on BullMQ workers, which keep their
 * own blocking connections and reconnect by themselves.
 */
export class BullMqJobQueue implements JobQueue, SupervisedConnection {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private producer: RedisConnection;
  private lostListener?: (reason: unknown) => void;
  private closed = false;

  constructor(private readonly connection: ConnectionOptions = producerConnection()) {
    this.producer = this.openProducer();
  }

  onLost(listener: (reason: unknown) => void): void {
    this.lostListener = listener;
  }

  /** Opens the producer connection. */
  async connect(): Promise<void> {
    const client = await this.producer.client;
    if (client.status !== "ready") await client.connect();
  }

  /** Rejects while Redis is unreachable or slower to answer than `REDIS_COMMAND_TIMEOUT_MS`. */
  async ready(): Promise<void> {
    await this.command((client) => client.info());
  }

  async enqueue(
    name: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<JobReference> {
    const job = await this.command((client) => this.queue(name, client).add(name, payload, {
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      ...(options.deduplicationKey === undefined
        ? {}
        : { deduplication: { id: options.deduplicationKey } }),
    }));
    if (job.id === undefined) throw new Error("BullMQ did not assign a job id");
    return { id: externalJobId(name, job.id), name };
  }

  async get(externalId: string): Promise<JobSnapshot | null> {
    const parsed = parseExternalJobId(externalId);
    if (!parsed) return null;
    const job = await this.command((client) => this.queue(parsed.name, client).getJob(parsed.id));
    if (!job) return null;
    const state = await this.command(() => job.getState());
    return {
      id: externalId,
      name: parsed.name,
      status: statusOf(state),
      attempts: job.attemptsMade,
      createdAt: job.timestamp,
      updatedAt: job.finishedOn ?? job.processedOn ?? job.timestamp,
      ...(job.returnvalue === undefined ? {} : { result: job.returnvalue as unknown }),
      ...(job.failedReason ? { error: job.failedReason } : {}),
    };
  }

  process(name: string, handler: JobHandler): Promise<Unsubscribe> {
    if (this.workers.has(name)) throw new Error(`A handler is already registered for job ${name}`);
    const worker = new Worker(
      name,
      async (job): Promise<void> => {
        await handler(job.data as unknown, {
          id: externalJobId(name, String(job.id)),
          name,
        });
      },
      { connection: redisConnection() },
    );
    this.workers.set(name, worker);
    return Promise.resolve(async () => {
      this.workers.delete(name);
      await worker.close();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([
      ...[...this.workers.values()].map((worker) => worker.close()),
      ...[...this.queues.values()].map((queue) => queue.close()),
    ]);
    this.workers.clear();
    this.queues.clear();
    await this.producer.close(true);
  }

  /**
   * Runs `send` on the producer connection and fails it with JOBS_UNAVAILABLE
   * while the connection is closed or when Redis does not answer in time.
   */
  private async command<T>(send: (client: RedisClient) => Promise<T>): Promise<T> {
    const producer = this.producer;
    const client = await producer.client;
    if (client.status !== "ready") throw jobsUnavailable();
    try {
      return await send(client);
    } catch (error) {
      const timedOut = isReplyTimeout(error);
      if (timedOut && producer === this.producer) this.replaceProducer(error);
      if (timedOut || producer !== this.producer || client.status !== "ready") throw jobsUnavailable();
      throw error;
    }
  }

  private openProducer(): RedisConnection {
    const producer = new RedisConnection(this.connection, {
      shared: false,
      blocking: false,
      ...NO_STARTUP_ROUND_TRIP,
    });
    // Connection errors reach callers as JOBS_UNAVAILABLE and the supervisor's log.
    producer.on("error", () => undefined);
    producer.on("close", () => {
      if (producer === this.producer) this.report(new Error("Connection closed"));
    });
    return producer;
  }

  /**
   * Redis answers in order, so after a reply times out every later command
   * would wait behind it, and a server that stopped answering never completes
   * the close either. The connection is dropped for a new one that the
   * supervisor opens.
   */
  private replaceProducer(reason: unknown): void {
    const stale = this.producer;
    const queues = [...this.queues.values()];
    this.queues.clear();
    this.producer = this.openProducer();
    void Promise.all(queues.map((queue) => queue.close()))
      .then(() => stale.close(true))
      .catch(() => undefined);
    this.report(reason);
  }

  private report(reason: unknown): void {
    if (!this.closed) this.lostListener?.(reason);
  }

  private queue(name: string, client: RedisClient): Queue {
    const current = this.queues.get(name);
    if (current) return current;
    const queue = new Queue(name, { connection: client, ...NO_STARTUP_ROUND_TRIP });
    // It reports the producer connection's errors, which `openProducer` already handles.
    queue.on("error", () => undefined);
    this.queues.set(name, queue);
    return queue;
  }
}
