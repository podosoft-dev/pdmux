import { Queue } from "bullmq";
import { redisConnection } from "../jobs/queue";

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

export interface JobProvider {
  enqueue(queue: string, name: string, data: Record<string, unknown>): Promise<JobSnapshot>;
  get(queue: string, id: string): Promise<JobSnapshot | null>;
  register(queue: string, name: string, processor: JobProcessor): void;
  repeat(queue: string, name: string, data: Record<string, unknown>, options: RepeatJobOptions): Promise<void>;
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

  repeat(
    queue: string,
    name: string,
    data: Record<string, unknown>,
    options: RepeatJobOptions,
  ): Promise<void> {
    if (this.timers.has(options.id)) return Promise.resolve();
    const timer = setInterval(() => { void this.enqueue(queue, name, data); }, options.intervalMs);
    timer.unref?.();
    this.timers.set(options.id, timer);
    return Promise.resolve();
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

export class BullMqJobProvider implements JobProvider {
  private readonly queues = new Map<string, Queue>();

  async enqueue(queue: string, name: string, data: Record<string, unknown>): Promise<JobSnapshot> {
    const job = await this.queue(queue).add(name, data);
    return { id: String(job.id), state: "waiting", result: null };
  }

  async get(queue: string, id: string): Promise<JobSnapshot | null> {
    const job = await this.queue(queue).getJob(id);
    if (!job) return null;
    return { id: String(job.id), state: await job.getState(), result: job.returnvalue ?? null };
  }

  register(_queue: string, _name: string, _processor: JobProcessor): void {}

  async repeat(
    queue: string,
    name: string,
    data: Record<string, unknown>,
    options: RepeatJobOptions,
  ): Promise<void> {
    await this.queue(queue).add(name, data, {
      repeat: { pattern: options.cron },
      jobId: options.id,
      removeOnComplete: true,
      removeOnFail: 20,
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: redisConnection() });
      this.queues.set(name, queue);
    }
    return queue;
  }
}
