import { describe, expect, it } from "@jest/globals";
import { buildSeries, clampPct, retentionCutoff, shouldSample } from "./metric-series";

describe("[TC-PDMETRIC-001] metric downsampling", () => {
  const step = 30;

  it("stores the first sample immediately", () => {
    expect(shouldSample(null, new Date("2026-07-25T10:00:00Z"), step)).toBe(true);
  });

  it("drops beats that land inside the step and keeps the one that closes it", () => {
    const last = new Date("2026-07-25T10:00:00Z");
    expect(shouldSample(last, new Date("2026-07-25T10:00:05Z"), step)).toBe(false);
    expect(shouldSample(last, new Date("2026-07-25T10:00:29Z"), step)).toBe(false);
    expect(shouldSample(last, new Date("2026-07-25T10:00:30Z"), step)).toBe(true);
    expect(shouldSample(last, new Date("2026-07-25T10:05:00Z"), step)).toBe(true);
  });

  it("refuses a sample dated before the newest stored one", () => {
    // An agent whose clock jumped backwards would otherwise pass the gate on every
    // single heartbeat, writing a row per beat forever.
    const last = new Date("2026-07-25T10:00:00Z");
    expect(shouldSample(last, new Date("2026-07-25T09:59:00Z"), step)).toBe(false);
  });
});

describe("[TC-PDMETRIC-005] percentage clamping", () => {
  it("bounds values to the protocol's 0..100 integers", () => {
    expect(clampPct(12.4)).toBe(12);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(900)).toBe(100);
    expect(clampPct(null)).toBeNull();
    expect(clampPct(undefined)).toBeNull();
    expect(clampPct(Number.NaN)).toBeNull();
  });
});

describe("[TC-PDMETRIC-003] series construction", () => {
  const now = new Date("2026-07-25T10:00:00Z");
  const at = (offsetSec: number): Date => new Date(now.getTime() + offsetSec * 1000);

  it("lays samples on a time grid whose right edge is now", () => {
    const series = buildSeries(
      [
        { ts: at(-60), cpuPct: 10, memPct: 40, diskPct: 50 },
        { ts: at(-30), cpuPct: 20, memPct: 41, diskPct: 50 },
        { ts: at(0), cpuPct: 30, memPct: 42, diskPct: 50 },
      ],
      { now, windowSec: 120, stepSec: 30 },
    );

    expect(series.step).toBe(30);
    expect(series.t).toHaveLength(5);
    expect(series.t.at(-1)).toBe(Math.floor(now.getTime() / 1000));
    expect(series.cpu).toEqual([null, null, 10, 20, 30]);
    expect(series.mem.at(-1)).toBe(42);
  });

  it("leaves a gap null so the graph can break the line", () => {
    const series = buildSeries(
      [
        { ts: at(-120), cpuPct: 10, memPct: null, diskPct: null },
        // Nothing measured for two steps — the collector could not reach the host.
        { ts: at(0), cpuPct: 30, memPct: null, diskPct: null },
      ],
      { now, windowSec: 120, stepSec: 30 },
    );

    expect(series.cpu).toEqual([10, null, null, null, 30]);
  });

  it("ignores samples outside the window", () => {
    const series = buildSeries([{ ts: at(-3600), cpuPct: 99, memPct: null, diskPct: null }], {
      now,
      windowSec: 120,
      stepSec: 30,
    });
    expect(series.cpu.every((value) => value === null)).toBe(true);
  });
});

describe("[TC-PDMETRIC-004] retention arithmetic", () => {
  it("computes the cutoff from whole days and never accepts zero", () => {
    const now = new Date("2026-07-25T10:00:00Z");
    expect(retentionCutoff(now, 7).toISOString()).toBe("2026-07-18T10:00:00.000Z");
    expect(retentionCutoff(now, 0).toISOString()).toBe("2026-07-24T10:00:00.000Z");
  });
});
