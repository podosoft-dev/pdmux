import { Queue, Worker } from "bullmq";
import type {
  EnqueueOptions,
  JobHandler,
  JobQueue,
  JobReference,
  JobSnapshot,
  JobStatus,
  Unsubscribe,
} from "@podosoft/podokit-runtime";
import { redisConnection } from "./queue";

const ID_SEPARATOR = "~";

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

export class BullMqJobQueue implements JobQueue {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  async enqueue(
    name: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<JobReference> {
    const queue = this.queue(name);
    const job = await queue.add(name, payload, {
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      ...(options.deduplicationKey === undefined
        ? {}
        : { deduplication: { id: options.deduplicationKey } }),
    });
    if (job.id === undefined) throw new Error("BullMQ did not assign a job id");
    return { id: externalJobId(name, job.id), name };
  }

  async get(externalId: string): Promise<JobSnapshot | null> {
    const parsed = parseExternalJobId(externalId);
    if (!parsed) return null;
    const job = await this.queue(parsed.name).getJob(parsed.id);
    if (!job) return null;
    return {
      id: externalId,
      name: parsed.name,
      status: statusOf(await job.getState()),
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
    await Promise.all([
      ...[...this.workers.values()].map((worker) => worker.close()),
      ...[...this.queues.values()].map((queue) => queue.close()),
    ]);
    this.workers.clear();
    this.queues.clear();
  }

  private queue(name: string): Queue {
    const current = this.queues.get(name);
    if (current) return current;
    const queue = new Queue(name, { connection: redisConnection() });
    this.queues.set(name, queue);
    return queue;
  }
}
