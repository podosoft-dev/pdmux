/**
 * Pure metric maths: what to store, and what to hand the graph.
 *
 * Both rules exist because of failures the previous tool hit — writing every
 * heartbeat, and drawing a straight line across a gap where nothing was measured.
 */

export interface MetricPoint {
  ts: Date;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
}

/** Aligned arrays instead of an array of objects: this is what a sparkline reads,
 *  and it is roughly a third of the JSON for the same 120 points. */
export interface MetricSeries {
  /** Sample times, oldest first (unix seconds). */
  t: number[];
  cpu: (number | null)[];
  mem: (number | null)[];
  disk: (number | null)[];
  step: number;
  window: number;
}

/**
 * Store this sample? Only if a full step has passed since the last stored one.
 *
 * A never-sampled host (`lastTs === null`) always stores, so the first beat after
 * an agent connects shows up immediately rather than one step later.
 */
export function shouldSample(lastTs: Date | null, ts: Date, stepSec: number): boolean {
  if (!lastTs) return true;
  const step = Math.max(1, stepSec);
  // Clock skew: a sample dated before the newest stored one would otherwise pass
  // this test forever, writing a row per heartbeat.
  const deltaSec = (ts.getTime() - lastTs.getTime()) / 1000;
  if (deltaSec < 0) return false;
  return deltaSec >= step;
}

/** Clamp a percentage to the protocol's 0..100 integer, or null if unusable. */
export function clampPct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Snap samples onto a fixed time grid ending at `now`.
 *
 * The x axis is time, not sample index: if the collector dies, the graph must
 * drift left and empty out instead of stretching the last known values across the
 * whole card. Buckets with no sample stay `null` so the renderer can break the
 * line there (§C8 of the tool this replaces learned that the hard way).
 */
export function buildSeries(
  samples: MetricPoint[],
  options: { now: Date; windowSec: number; stepSec: number },
): MetricSeries {
  const step = Math.max(1, Math.round(options.stepSec));
  const windowSec = Math.max(step, Math.round(options.windowSec));
  const endSec = Math.floor(options.now.getTime() / 1000 / step) * step;
  const count = Math.floor(windowSec / step) + 1;
  const startSec = endSec - (count - 1) * step;

  const t: number[] = [];
  for (let i = 0; i < count; i++) t.push(startSec + i * step);
  const cpu: (number | null)[] = new Array<number | null>(count).fill(null);
  const mem: (number | null)[] = new Array<number | null>(count).fill(null);
  const disk: (number | null)[] = new Array<number | null>(count).fill(null);

  for (const sample of samples) {
    const sec = Math.floor(sample.ts.getTime() / 1000);
    if (sec < startSec - step || sec > endSec + step) continue;
    const index = Math.min(count - 1, Math.max(0, Math.round((sec - startSec) / step)));
    // Last write wins inside a bucket: with step-aligned writing there is at most
    // one sample per bucket, and after a settings change the newer value is right.
    cpu[index] = clampPct(sample.cpuPct);
    mem[index] = clampPct(sample.memPct);
    disk[index] = clampPct(sample.diskPct);
  }

  return { t, cpu, mem, disk, step, window: windowSec };
}

/** Cutoff for the retention job. Separated so the arithmetic is testable. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  const days = Math.max(1, Math.round(retentionDays));
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
