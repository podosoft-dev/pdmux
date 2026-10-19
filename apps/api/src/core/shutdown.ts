/** WebSocket close code for a server that is going down; clients reconnect elsewhere. */
export const GOING_AWAY = 1001;

/** How long a force-close may take after the shutdown timeout. */
export const FORCE_CLOSE_MS = 1_000;

/** How long closing the services (database pool, Redis, and others) may take. */
export const CLOSE_SERVICES_MS = 3_000;

interface Listener {
  run: () => void;
}

/**
 * Tells long-lived connections that the API is shutting down. Server-sent event
 * streams and WebSockets never finish on their own, so each registers here and
 * ends when shutdown starts, and its client reconnects to another instance
 * instead of holding the process until the shutdown timeout.
 */
export class Shutdown {
  private readonly controller = new AbortController();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly onListenerError: (error: unknown) => void = () => undefined) {}

  /** Aborts when shutdown starts. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get started(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Runs `listener` when shutdown starts, or at once when it already has. Call
   * the returned function when the connection closes on its own.
   */
  onShutdown(listener: () => void): () => void {
    if (this.started) {
      this.call(listener);
      return () => undefined;
    }
    const entry: Listener = { run: listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  begin(): void {
    if (this.started) return;
    this.controller.abort();
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const { run } of listeners) this.call(run);
  }

  private call(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.onListenerError(error);
    }
  }
}

/** True when `promise` settles within `ms`; a rejection counts as settled. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StoppableServer {
  /** Stops accepting connections; without `force`, resolves once open ones finish. */
  stop(force?: boolean): Promise<unknown>;
}

export interface StopOptions {
  /** Stops the server gently: no new connections, in-flight requests finish. */
  stop: () => Promise<unknown>;
  /** The listening server, force-closed when the timeout passes. */
  server?: StoppableServer;
  shutdown: Shutdown;
  closeServices: () => Promise<void>;
  timeoutMs: number;
  forceCloseMs?: number;
  closeServicesMs?: number;
}

export interface StopResult {
  /** False when connections were still open at the timeout and were force-closed. */
  drained: boolean;
  /** False when the services did not close in time. */
  servicesClosed: boolean;
}

/**
 * Stops accepting connections, ends streams and WebSockets at once through
 * `shutdown`, gives in-flight requests up to `timeoutMs`, force-closes whatever
 * is still open, and closes the services. Every wait is bounded, so the process
 * can exit within the orchestrator's grace period.
 */
export async function stopGracefully(options: StopOptions): Promise<StopResult> {
  // Called first, so the server stops accepting before clients told to reconnect
  // can reach it again.
  const stopped = options.stop();
  options.shutdown.begin();
  const drained = await settlesWithin(stopped, options.timeoutMs);
  if (!drained && options.server) {
    // A pending graceful stop may never settle after a force-close, so this is bounded too.
    await settlesWithin(options.server.stop(true), options.forceCloseMs ?? FORCE_CLOSE_MS);
  }
  const servicesClosed = await settlesWithin(options.closeServices(), options.closeServicesMs ?? CLOSE_SERVICES_MS);
  return { drained, servicesClosed };
}
