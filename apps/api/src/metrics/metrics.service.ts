import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Between, In, LessThan, Repository } from "typeorm";
import type { Heartbeat } from "@pdmux/protocol";
import { HostMetricSample } from "./host-metric-sample.entity";
import {
  buildSeries,
  clampPct,
  retentionCutoff,
  shouldSample,
  type MetricSeries,
} from "./metric-series";

function toBigintString(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return String(Math.max(0, Math.round(value)));
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class MetricsService {
  /**
   * Newest stored sample time per host.
   *
   * The cache exists so the common path (a heartbeat that must be dropped) costs
   * nothing: without it every beat from every host is a SELECT just to decide not
   * to write. A cold process falls back to the DB once per host.
   */
  private readonly lastSampleAt = new Map<string, Date>();

  constructor(
    @InjectRepository(HostMetricSample) private readonly samples: Repository<HostMetricSample>,
  ) {}

  /** Returns the row when one was stored, null when the beat fell inside a step. */
  async recordHeartbeat(
    hostId: string,
    heartbeat: Heartbeat,
    stepSec: number,
  ): Promise<HostMetricSample | null> {
    const ts = new Date(heartbeat.ts * 1000);
    const last = await this.lastSampleTime(hostId);
    if (!shouldSample(last, ts, stepSec)) return null;

    const resource = heartbeat.resource;
    const row = await this.samples.save(
      this.samples.create({
        hostId,
        ts,
        cpuPct: clampPct(resource.cpuPct),
        memPct: clampPct(resource.memPct),
        diskPct: clampPct(resource.diskPct),
        memUsedBytes: toBigintString(resource.memUsedBytes),
        memTotalBytes: toBigintString(resource.memTotalBytes),
        diskUsedBytes: toBigintString(resource.diskUsedBytes),
        diskTotalBytes: toBigintString(resource.diskTotalBytes),
        // ⚠ A MEASURED 0 MUST SURVIVE AS 0, NOT BECOME null. Both helpers already
        // do that (`clampPct(0)` is 0, `toBigintString(0)` is "0") — but a future
        // falsy check in either one would silently turn every swapless host back
        // into an unanswered one, which is the whole distinction these three carry.
        swapPct: clampPct(resource.swapPct),
        swapUsedBytes: toBigintString(resource.swapUsedBytes),
        swapTotalBytes: toBigintString(resource.swapTotalBytes),
      }),
    );
    this.lastSampleAt.set(hostId, ts);
    return row;
  }

  async series(
    hostId: string,
    options: { windowSec: number; stepSec: number; now?: Date },
  ): Promise<MetricSeries> {
    const now = options.now ?? new Date();
    const from = new Date(now.getTime() - options.windowSec * 1000 - options.stepSec * 1000);
    const rows = await this.samples.find({
      where: { hostId, ts: Between(from, now) },
      order: { ts: "ASC" },
    });
    return buildSeries(rows, { now, windowSec: options.windowSec, stepSec: options.stepSec });
  }

  /** Latest absolute byte counts, for the tooltip that a percentage cannot fill. */
  async latest(hostId: string): Promise<{
    ts: string;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    swapUsedBytes: number | null;
    swapTotalBytes: number | null;
  } | null> {
    const row = await this.samples.findOne({ where: { hostId }, order: { ts: "DESC" } });
    if (!row) return null;
    return {
      ts: row.ts.toISOString(),
      memUsedBytes: toNumber(row.memUsedBytes),
      memTotalBytes: toNumber(row.memTotalBytes),
      diskUsedBytes: toNumber(row.diskUsedBytes),
      diskTotalBytes: toNumber(row.diskTotalBytes),
      swapUsedBytes: toNumber(row.swapUsedBytes),
      swapTotalBytes: toNumber(row.swapTotalBytes),
    };
  }

  /** Deletes samples older than the retention window. Returns rows removed. */
  async prune(retentionDays: number, now: Date = new Date()): Promise<number> {
    const cutoff = retentionCutoff(now, retentionDays);
    const result = await this.samples.delete({ ts: LessThan(cutoff) });
    const affected = result.affected ?? 0;
    if (affected > 0) this.lastSampleAt.clear();
    return affected;
  }

  /** Same, restricted to one scope's hosts (retention is a per-organization setting). */
  async pruneHosts(hostIds: string[], cutoff: Date): Promise<number> {
    if (hostIds.length === 0) return 0;
    const result = await this.samples.delete({ hostId: In(hostIds), ts: LessThan(cutoff) });
    const affected = result.affected ?? 0;
    // The newest sample per host is never older than the cutoff in practice, but a
    // clock jump could delete it — drop the cache rather than keep a phantom.
    if (affected > 0) for (const hostId of hostIds) this.lastSampleAt.delete(hostId);
    return affected;
  }

  private async lastSampleTime(hostId: string): Promise<Date | null> {
    const cached = this.lastSampleAt.get(hostId);
    if (cached) return cached;
    const row = await this.samples.findOne({
      where: { hostId },
      order: { ts: "DESC" },
      select: { id: true, ts: true },
    });
    if (row) this.lastSampleAt.set(hostId, row.ts);
    return row?.ts ?? null;
  }
}
