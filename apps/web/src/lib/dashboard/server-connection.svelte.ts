/**
 * Whether this browser can reach the pdmux server right now.
 *
 * ⚠ THERE WAS NO SUCH STATE, AND THE SCREEN LIED ABOUT IT. With the reverse proxy down for a few
 * minutes the host cards kept their last colours and their "last seen" froze, and every pane kept
 * its last frame while keystrokes went nowhere — a dashboard that looked healthy and was not. A
 * failed poll only recorded an error code nothing drew, and the fleet event stream gave up for good
 * on its first HTTP error. Each of those signals now reports here, and the sidebar and the panes
 * read one answer.
 *
 * Three states rather than a boolean: `reconnecting` right after the loss, `offline` once it has
 * lasted long enough that the screen should stop implying it is a blip. Both keep retrying.
 */
import { ApiError } from "@podosoft/podokit-api-client";

export type ServerConnectionState = "online" | "reconnecting" | "offline";

/** How long a loss reads as `reconnecting` before it is called `offline`. */
export const OFFLINE_AFTER_MS = 30_000;

export interface ServerConnectionOptions {
  offlineAfterMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Did this failure come from not reaching the server, rather than from the server answering no?
 *
 * A network error and the gateway statuses a proxy or the web server answers with while the API
 * is away (502 · 503 · 504) are an outage. Anything else — a 401, a 404, a validation error — is
 * the server answering, so it is reachable even though the request failed.
 */
export function isServerUnreachable(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  return cause.statusCode === 0 || (cause.statusCode >= 502 && cause.statusCode <= 504);
}

export class ServerConnection {
  state = $state<ServerConnectionState>("online");
  /** Epoch ms of the loss, while there is one. */
  lostAt = $state<number | null>(null);

  private readonly offlineAfterMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private offlineHandle: unknown = null;
  private readonly recoverListeners = new Set<() => void>();

  constructor(options: ServerConnectionOptions = {}) {
    this.offlineAfterMs = options.offlineAfterMs ?? OFFLINE_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get online(): boolean {
    return this.state === "online";
  }

  /** Runs after every recovery — the moment to read again what changed while away. */
  onRecover(listener: () => void): () => void {
    this.recoverListeners.add(listener);
    return () => this.recoverListeners.delete(listener);
  }

  /**
   * The server answered. Returns true when that ended a loss, so a caller about to read can
   * leave the reading to the recovery listeners instead of doing it twice.
   */
  alive(): boolean {
    if (this.state === "online") return false;
    this.clearOffline();
    this.state = "online";
    this.lostAt = null;
    for (const listener of [...this.recoverListeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
    return true;
  }

  /** The server could not be reached. Repeats during one loss change nothing. */
  lost(): void {
    if (this.state !== "online") return;
    this.state = "reconnecting";
    this.lostAt = this.now();
    this.offlineHandle = this.schedule(() => {
      this.offlineHandle = null;
      if (this.state === "reconnecting") this.state = "offline";
    }, this.offlineAfterMs);
  }

  dispose(): void {
    this.clearOffline();
    this.recoverListeners.clear();
  }

  private clearOffline(): void {
    if (this.offlineHandle !== null) this.cancel(this.offlineHandle);
    this.offlineHandle = null;
  }
}

/** How long a host's terminal socket may be away before its panes are covered. */
export const TRANSPORT_GRACE_MS = 3_000;

/**
 * Which hosts' terminal sockets have been away for longer than a blip.
 *
 * ⚠ NOT ON THE FIRST `reconnecting`. A socket that drops and comes back in a second is the common
 * case (a phone resuming, a deploy), and covering every pane for it would be worse than the small
 * note the pane already shows. Only a loss that outlives the grace covers the pane.
 */
export class TransportLoss {
  lost = $state<Record<string, boolean>>({});

  private readonly graceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly timers = new Map<string, unknown>();

  constructor(options: Pick<ServerConnectionOptions, "schedule" | "cancel"> & { graceMs?: number } = {}) {
    this.graceMs = options.graceMs ?? TRANSPORT_GRACE_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  note(hostId: string, status: string): void {
    if (status === "reconnecting") {
      if (this.timers.has(hostId) || this.lost[hostId]) return;
      this.timers.set(hostId, this.schedule(() => {
        this.timers.delete(hostId);
        this.lost = { ...this.lost, [hostId]: true };
      }, this.graceMs));
      return;
    }
    const timer = this.timers.get(hostId);
    if (timer !== undefined) this.cancel(timer);
    this.timers.delete(hostId);
    if (this.lost[hostId]) {
      const { [hostId]: _gone, ...rest } = this.lost;
      this.lost = rest;
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
  }
}
