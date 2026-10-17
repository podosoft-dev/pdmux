import { Worker, type Processor, type WorkerOptions } from "bullmq";
import { configureWorkers } from "../worker.extensions";
import { processDemoJob } from "./demo.processor";
import { DEMO_QUEUE, redisConnection } from "./queue";
// podokit:begin:worker-imports
// podokit:end:worker-imports

export interface WorkerDefinition {
  queue: string;
  processor: Processor;
  /** BullMQ worker options other than the connection, such as `concurrency`. */
  options?: Omit<WorkerOptions, "connection">;
}

export interface WorkerSetup {
  /** Runs `close` when the worker process stops, after its workers; the last one registered runs first. */
  onClose(close: () => void | Promise<void>): void;
}

export interface WorkerRuntime {
  workers: Worker[];
  close(): Promise<void>;
}

const definitions: WorkerDefinition[] = [
  { queue: DEMO_QUEUE, processor: processDemoJob },
  // podokit:begin:worker-processors
  // podokit:end:worker-processors
];

export interface CollectedWorkers {
  definitions: WorkerDefinition[];
  /** Releases what `configure` opened. */
  release(): Promise<void>;
}

/** PodoKit's queues followed by the application's from worker.extensions.ts; one worker per queue. */
export async function collectWorkers(
  configure: (setup: WorkerSetup) => Promise<WorkerDefinition[]> = configureWorkers,
): Promise<CollectedWorkers> {
  const closers: Array<() => void | Promise<void>> = [];
  const release = async (): Promise<void> => {
    for (const close of closers.splice(0).reverse()) await close();
  };
  try {
    const all = [...definitions, ...await configure({ onClose: (close) => closers.push(close) })];
    const queues = all.map((definition) => definition.queue);
    const repeated = queues.filter((queue, index) => queues.indexOf(queue) !== index);
    if (repeated.length > 0) throw new Error(`More than one worker for queue ${[...new Set(repeated)].join(", ")}`);
    return { definitions: all, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function startWorkers(): Promise<WorkerRuntime> {
  const { definitions: all, release } = await collectWorkers();
  const workers = all.map(({ queue, processor, options }) =>
    new Worker(queue, processor, { ...options, connection: redisConnection() })
  );
  return {
    workers,
    close: async (): Promise<void> => {
      await Promise.all(workers.map((worker) => worker.close()));
      await release();
    },
  };
}
