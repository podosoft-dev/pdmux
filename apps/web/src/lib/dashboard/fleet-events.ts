/** What the event stream reports about the server — see `ServerConnection`. */
export interface ConnectionReport {
  /** The server answered; true when that ended a loss. */
  alive(): boolean;
  lost(): void;
}

export interface FleetEventsOptions {
  connection?: ConnectionReport;
  /** No event for this long means the stream is dead even if the socket says otherwise. */
  silenceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
}

/**
 * The API sends `heartbeat` every 5 seconds (`apps/api/src/pdmux/fleet-events.ts`), so three
 * missed beats is a stream that stopped — a proxy holding a half-open connection, or a laptop
 * that slept — and not a slow one.
 */
export const FLEET_SILENCE_MS = 15_000;

/**
 * One visible-page SSE subscription; REST polling remains the recovery path.
 *
 * ⚠ AN EventSource GIVES UP FOR GOOD ON AN HTTP ERROR. A reverse proxy that answered 502 for
 * three minutes used to leave this page with no stream at all until the tab was hidden and
 * shown again. It now closes the source on an error and dials again with exponential backoff,
 * the same rule `EventStreamClient` follows, and treats a silent stream as a dead one.
 */
export class FleetEvents {
  private source: EventSource | null = null;
  private started = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastEventAt = 0;
  private readonly options: FleetEventsOptions;

  /**
   * `refresh` reloads the hosts on an invalidation. `reload` runs instead on
   * `resync`, which the API sends after its event bus was interrupted: notices
   * from that time were lost, so everything on screen is read again.
   */
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly reload: () => Promise<void>,
    options: FleetEventsOptions = {},
  ) {
    this.options = options;
  }

  private readonly visibility = (): void => {
    this.disconnect();
    this.attempt = 0;
    if (document.visibilityState !== "hidden") this.connect();
  };

  start(): void {
    if (this.started || typeof EventSource === "undefined" || typeof document === "undefined") return;
    this.started = true;
    document.addEventListener("visibilitychange", this.visibility);
    this.visibility();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener("visibilitychange", this.visibility);
    this.disconnect();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private connect(): void {
    const source = new EventSource("/api/fleet/events");
    this.source = source;
    this.lastEventAt = this.now();
    source.onmessage = (event: MessageEvent<string>): void => {
      if (this.source !== source) return;
      this.lastEventAt = this.now();
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // Invalid events do not interrupt the polling recovery path.
      }
      if (typeof data !== "object" || data === null || !("type" in data)) return;
      this.attempt = 0;
      // A recovery reads everything again through the connection's listeners, so the
      // invalidation that announced it is not read a second time here.
      const recovered = this.options.connection?.alive() ?? false;
      if (data.type === "resync") void this.reload();
      else if ((data.type === "hosts.changed" || data.type === "ready") && !recovered) void this.refresh();
    };
    source.onerror = (): void => {
      if (this.source === source) this.failed();
    };
    const silenceMs = this.options.silenceMs ?? FLEET_SILENCE_MS;
    this.watchdog = setInterval(() => {
      if (this.source === source && this.now() - this.lastEventAt > silenceMs) this.failed();
    }, Math.max(250, Math.floor(silenceMs / 3)));
  }

  private failed(): void {
    this.disconnect();
    this.options.connection?.lost();
    if (!this.started) return;
    const minimum = this.options.minBackoffMs ?? 1_000;
    const maximum = this.options.maxBackoffMs ?? 30_000;
    const ceiling = Math.min(maximum, minimum * 2 ** this.attempt);
    const delay = Math.round(ceiling / 2 + (this.options.random ?? Math.random)() * (ceiling / 2));
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started && document.visibilityState !== "hidden") this.connect();
    }, delay);
  }

  private disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }
}
