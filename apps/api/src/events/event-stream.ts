import type { EventSubscriber } from "./event-envelope";

export type StreamFrame =
  | { kind: "event"; id: string; data: string }
  | { kind: "resync" }
  | { kind: "heartbeat" };

type EventFrame = Extract<StreamFrame, { kind: "event" }>;

const RESYNC: StreamFrame = { kind: "resync" };
const HEARTBEAT: StreamFrame = { kind: "heartbeat" };

export interface Scheduler {
  /** Runs `task` every `intervalMs` until the returned function is called. */
  every(intervalMs: number, task: () => void): () => void;
}

export const timerScheduler: Scheduler = {
  every: (intervalMs, task) => {
    const timer = setInterval(task, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export interface EventStreamOptions {
  queueLimit: number;
  heartbeatMs: number;
  maxConnectionMs: number;
  scheduler: Scheduler;
  now: () => number;
}

/**
 * One subscriber connection. Frames are pulled by the response body, so a slow
 * client fills the bounded queue; on overflow the backlog is dropped and the
 * client receives a single `resync` frame telling it to refetch state.
 */
export class EventStream {
  private readonly queue: EventFrame[] = [];
  private readonly openedAt: number;
  private readonly onAbort = (): void => this.close();
  private resyncPending = false;
  private heartbeatPending = false;
  private sequence = 0;
  private closed = false;
  private waiter?: () => void;
  private stopHeartbeat?: () => void;
  private signal?: AbortSignal;

  constructor(
    readonly subscriber: EventSubscriber,
    readonly topics: ReadonlySet<string> | undefined,
    private readonly options: EventStreamOptions,
    private readonly onClose: (stream: EventStream) => void,
  ) {
    this.openedAt = options.now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Binds the stream to its request. An already aborted signal closes it at once. */
  start(signal: AbortSignal): void {
    if (this.closed) return;
    if (signal.aborted) {
      this.close();
      return;
    }
    this.signal = signal;
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.stopHeartbeat = this.options.scheduler.every(this.options.heartbeatMs, () => this.tick());
  }

  offer(data: string, id: string | undefined): void {
    if (this.closed) return;
    if (this.queue.length >= this.options.queueLimit) {
      this.resync();
      return;
    }
    this.queue.push({ kind: "event", id: id ?? String(++this.sequence), data });
    this.wake();
  }

  /** Drops the backlog and sends one `resync` frame, telling the client to reload its state. */
  resync(): void {
    if (this.closed) return;
    this.queue.length = 0;
    this.resyncPending = true;
    this.wake();
  }

  /** Resolves the next frame, or undefined once the stream is closed. Single consumer. */
  async next(): Promise<StreamFrame | undefined> {
    while (!this.closed) {
      const frame = this.take();
      if (frame) return frame;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.signal = undefined;
    this.onClose(this);
    this.wake();
  }

  private take(): StreamFrame | undefined {
    if (this.resyncPending) {
      this.resyncPending = false;
      return RESYNC;
    }
    const event = this.queue.shift();
    if (event) {
      this.heartbeatPending = false;
      return event;
    }
    if (this.heartbeatPending) {
      this.heartbeatPending = false;
      return HEARTBEAT;
    }
    return undefined;
  }

  private tick(): void {
    // The identity was resolved at connect. Ending long-lived streams makes the
    // client reconnect and re-authenticate, so revoked sessions and roles lapse.
    if (this.options.now() - this.openedAt >= this.options.maxConnectionMs) {
      this.close();
      return;
    }
    this.heartbeatPending = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}

/**
 * Data events use the default `message` type with `{ topic, data }` as JSON, so
 * `EventSource.onmessage` keeps working. Control frames use a named event or a
 * comment and never reach `onmessage`.
 */
export function encodeFrame(frame: StreamFrame): string {
  switch (frame.kind) {
    case "event":
      return `id: ${frame.id}\ndata: ${frame.data}\n\n`;
    case "resync":
      return "event: resync\ndata: {}\n\n";
    case "heartbeat":
      return ": heartbeat\n\n";
  }
}

export function eventStreamResponse(stream: EventStream, retryMs: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
    },
    async pull(controller): Promise<void> {
      const frame = await stream.next();
      if (frame) {
        controller.enqueue(encoder.encode(encodeFrame(frame)));
        return;
      }
      try {
        controller.close();
      } catch {
        // The body was cancelled while this pull was waiting.
      }
    },
    cancel(): void {
      stream.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
