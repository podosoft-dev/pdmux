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
