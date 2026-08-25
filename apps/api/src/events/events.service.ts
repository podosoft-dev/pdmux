import { ReadinessService } from "../health/readiness.service";
import type { EventsTransport } from "./events.transport";

type LocalHandler = (data: unknown) => void;

export class EventsService {
  private readonly handlers = new Set<LocalHandler>();
  private unregisterReadiness?: () => void;

  constructor(
    private readonly transport: EventsTransport,
    private readonly readiness: ReadinessService,
  ) {}

  async connect(): Promise<void> {
    await this.transport.connect((data) => this.publishLocal(data));
    this.unregisterReadiness = this.readiness.register("events", () => this.transport.ready());
  }

  publish(data: unknown): void {
    void this.publishAsync(data).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Publish event failed: ${message}\n`);
    });
  }

  publishAsync(data: unknown): Promise<void> {
    return this.transport.publish(data);
  }

  publishLocal(data: unknown): void {
    for (const handler of this.handlers) handler(data);
  }

  subscribe(handler: LocalHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async *stream(signal: AbortSignal): AsyncGenerator<unknown> {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.subscribe((data) => {
      queue.push(data);
      wake?.();
      wake = undefined;
    });
    let heartbeat = 0;
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          const delivered = await Promise.race([
            new Promise<"event">((resolve) => {
              wake = () => resolve("event");
            }),
            Bun.sleep(5_000).then(() => "heartbeat" as const),
          ]);
          if (delivered === "heartbeat") yield { type: "heartbeat", n: heartbeat++ };
        }
        while (queue.length > 0) yield queue.shift();
      }
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    this.unregisterReadiness?.();
    this.handlers.clear();
    await this.transport.close();
  }
}
