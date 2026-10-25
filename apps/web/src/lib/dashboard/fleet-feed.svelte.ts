/**
 * The live fleet: host rows now, metric trends over the window.
 *
 * TWO FEEDS, TWO CADENCES, ON PURPOSE. `GET /hosts` is one request that draws the
 * whole sidebar (rows + services + probe status). Scoped SSE invalidations request
 * a fresh snapshot; polling at the heartbeat interval recovers dropped events.
 * The metric series is per host and covers an hour, so it is
 * refreshed far more slowly — a sparkline whose pixels are 30s apart gains nothing
 * from being fetched every 5s, and re-reading it per host per poll would multiply
 * the load by the size of the fleet.
 *
 * A failed poll keeps the previous data on screen and records the error code. Blanking
 * the cards on one dropped request makes a working dashboard look broken.
 *
 * ⚠ KEEPING THE DATA IS NOT VOUCHING FOR IT. `now` used to advance only on a successful poll,
 * so an outage froze every card at its last moment — "last seen" stopped counting and the hosts
 * stayed green. `now` is the clock of the last attempt, and `connection` says whether the data
 * on screen is current; the shell draws it as unknown while it is not.
 */
import type { HostSeries } from "@pdmux/core";
import { errorCode, hostsApi, metricsApi } from "./api";
import { hostSeries } from "./map";
import type { HostView } from "./types";
import { FleetEvents } from "./fleet-events";
import { ServerConnection, isServerUnreachable } from "./server-connection.svelte";

/** Never poll faster than this, whatever the fleet's heartbeat is set to. */
const MIN_POLL_MS = 2000;
const HISTORY_REFRESH_MS = 60_000;

export interface FleetFeedOptions {
  initialHosts?: HostView[];
  heartbeatSec?: number;
  /** Trend window in seconds; the sparklines draw the same span. */
  windowSec?: number;
  /** Session-only screens do not request metric trends. */
  includeHistory?: boolean;
  /** Injectable for tests; one is created otherwise. */
  connection?: ServerConnection;
}

export class FleetFeed {
  hosts = $state<HostView[]>([]);
  history = $state<Record<string, HostSeries>>({});
  /** Epoch ms of the last poll, answered or not — the cards' "now". */
  now = $state<number>(Date.now());
  /** Epoch ms of the last successful poll: how old `hosts` is. */
  lastSuccessAt = $state<number>(Date.now());
  /** Error code of the last failed poll, cleared by the next success. */
  error = $state<string | null>(null);
  /** Whether the server can be reached; the hosts on screen are only current while it can. */
  readonly connection: ServerConnection;

  readonly windowSec: number;
  private readonly pollMs: number;
  private readonly includeHistory: boolean;
  private hostTimer: ReturnType<typeof setInterval> | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private historyBusy = false;
  private reading: Promise<void> | null = null;
  private rereading: Promise<void> | null = null;
  private readonly events: FleetEvents;
  private stopRecover: (() => void) | null = null;

  constructor(options: FleetFeedOptions = {}) {
    this.connection = options.connection ?? new ServerConnection();
    this.events = new FleetEvents(() => this.refresh(), () => this.reload(), { connection: this.connection });
    this.includeHistory = options.includeHistory !== false;
    this.hosts = options.initialHosts ?? [];
    this.windowSec = options.windowSec ?? 3600;
    this.pollMs = Math.max(MIN_POLL_MS, (options.heartbeatSec ?? 5) * 1000);
  }

  /** True while the hosts on screen may no longer be what the server would say. */
  get stale(): boolean {
    return !this.connection.online;
  }

  start(): void {
    if (this.hostTimer) return;
    // Whatever changed while the server was away is read again — the hosts and the trends,
    // which would otherwise stay a minute behind on the history timer.
    this.stopRecover = this.connection.onRecover(() => void this.reload());
    void this.refresh();
    if (this.includeHistory) void this.refreshHistory();
    this.hostTimer = setInterval(() => void this.refresh(), this.pollMs);
    if (this.includeHistory) this.historyTimer = setInterval(() => void this.refreshHistory(), HISTORY_REFRESH_MS);
    this.events.start();
  }

  stop(): void {
    this.events.stop();
    this.stopRecover?.();
    this.stopRecover = null;
    if (this.hostTimer) clearInterval(this.hostTimer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.hostTimer = null;
    this.historyTimer = null;
  }

  /** Reads the hosts and then their trends again, as after a page load. */
  async reload(): Promise<void> {
    await this.refresh();
    await this.refreshHistory();
  }

  /**
   * Reads the hosts with a request that leaves AFTER this call.
   *
   * ⚠ NOT "join the read already on the wire". A poll or an SSE invalidation is often
   * mid-read, and that read may have left before the caller's own write landed. Joined,
   * it answered `removeHost` with the deleted host still in the fleet: nothing was pruned
   * and the saved layout kept a pane on a host that no longer exists. So a call during a
   * read waits for it and reads once more; every call made meanwhile shares that one
   * follow-up, which keeps the reads one at a time.
   */
  refresh(): Promise<void> {
    if (this.rereading) return this.rereading;
    if (!this.reading) return this.read();
    this.rereading = this.reading.then(() => {
      this.rereading = null;
      return this.read();
    });
    return this.rereading;
  }

  private read(): Promise<void> {
    const reading = this.fetchHosts().finally(() => {
      if (this.reading === reading) this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  private async fetchHosts(): Promise<void> {
    try {
      this.hosts = await hostsApi.list();
      this.lastSuccessAt = Date.now();
      this.error = null;
      this.connection.alive();
    } catch (cause: unknown) {
      this.error = errorCode(cause);
      if (isServerUnreachable(cause)) this.connection.lost();
      else this.connection.alive();
    } finally {
      this.now = Date.now();
    }
  }

  /**
   * Refresh every host's trend, one request at a time.
   *
   * Sequential rather than `Promise.all`: a fleet of thirty hosts would otherwise
   * open thirty connections at once, and nothing on screen needs them to land
   * together.
   */
  async refreshHistory(): Promise<void> {
    if (this.historyBusy) return;
    this.historyBusy = true;
    try {
      const next: Record<string, HostSeries> = { ...this.history };
      for (const host of this.hosts) {
        if (!host.enabled) continue;
        try {
          next[host.id] = hostSeries(await metricsApi.series(host.id, this.windowSec));
        } catch {
          // One host's history failing must not cost the others theirs.
        }
      }
      this.history = next;
    } finally {
      this.historyBusy = false;
    }
  }
}
