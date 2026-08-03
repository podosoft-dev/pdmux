/**
 * The live fleet: host rows now, metric trends over the window.
 *
 * TWO FEEDS, TWO CADENCES, ON PURPOSE. `GET /hosts` is one request that draws the
 * whole sidebar (rows + services + probe status), so it is polled at roughly the
 * heartbeat interval. The metric series is per host and covers an hour, so it is
 * refreshed far more slowly — a sparkline whose pixels are 30s apart gains nothing
 * from being fetched every 5s, and re-reading it per host per poll would multiply
 * the load by the size of the fleet.
 *
 * A failed poll keeps the previous data on screen and records the error code. Blanking
 * the cards on one dropped request makes a working dashboard look broken.
 */
import type { HostSeries } from "@pdmux/core";
import { errorCode, hostsApi, metricsApi } from "./api";
import { hostSeries } from "./map";
import type { HostView } from "./types";

/** Never poll faster than this, whatever the fleet's heartbeat is set to. */
const MIN_POLL_MS = 2000;
const HISTORY_REFRESH_MS = 60_000;

export interface FleetFeedOptions {
  initialHosts?: HostView[];
  heartbeatSec?: number;
  /** Trend window in seconds; the sparklines draw the same span. */
  windowSec?: number;
}

export class FleetFeed {
  hosts = $state<HostView[]>([]);
  history = $state<Record<string, HostSeries>>({});
  /** Epoch ms of the last successful poll — the cards' "now". */
  now = $state<number>(Date.now());
  /** Error code of the last failed poll, cleared by the next success. */
  error = $state<string | null>(null);

  readonly windowSec: number;
  private readonly pollMs: number;
  private hostTimer: ReturnType<typeof setInterval> | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private historyBusy = false;

  constructor(options: FleetFeedOptions = {}) {
    this.hosts = options.initialHosts ?? [];
    this.windowSec = options.windowSec ?? 3600;
    this.pollMs = Math.max(MIN_POLL_MS, (options.heartbeatSec ?? 5) * 1000);
  }

  start(): void {
    void this.refresh();
    void this.refreshHistory();
    this.hostTimer = setInterval(() => void this.refresh(), this.pollMs);
    this.historyTimer = setInterval(() => void this.refreshHistory(), HISTORY_REFRESH_MS);
  }

  stop(): void {
    if (this.hostTimer) clearInterval(this.hostTimer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.hostTimer = null;
    this.historyTimer = null;
  }

  async refresh(): Promise<void> {
    try {
      this.hosts = await hostsApi.list();
      this.now = Date.now();
      this.error = null;
    } catch (cause: unknown) {
      this.error = errorCode(cause);
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
