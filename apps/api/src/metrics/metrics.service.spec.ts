import { beforeEach, describe, expect, it } from "@jest/globals";
import type { Heartbeat } from "@pdmux/protocol";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "../hosts/host.entity";
import { FakeRepository } from "../testing/fake-repository";
import { HostMetricSample } from "./host-metric-sample.entity";
import { MetricsRetentionService } from "./metrics-retention.service";
import { MetricsService } from "./metrics.service";

function heartbeatAt(ts: number, cpuPct: number, swap?: Partial<Heartbeat["resource"]>): Heartbeat {
  return {
    ts,
    resource: {
      cpuPct,
      memPct: 40,
      diskPct: 50,
      memUsedBytes: 12 * 1024 ** 3,
      memTotalBytes: 30 * 1024 ** 3,
      diskUsedBytes: null,
      diskTotalBytes: null,
      swapPct: 25,
      swapUsedBytes: 2 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
      load1: null,
      uptimeSec: null,
      ...swap,
    },
    sessions: [],
    usage: [],
    diagnostics: [],
    listeners: [],
    services: [],
  };
}

describe("MetricsService", () => {
  let samples: FakeRepository<HostMetricSample>;
  let metrics: MetricsService;

  beforeEach(() => {
    samples = new FakeRepository<HostMetricSample>();
    metrics = new MetricsService(samples.asRepository());
  });

  it("[TC-PDMETRIC-002] writes one row per step, not one per heartbeat", async () => {
    const base = Math.floor(new Date("2026-07-25T10:00:00Z").getTime() / 1000);

    // 5s heartbeats over two minutes at a 30s step.
    for (let offset = 0; offset <= 120; offset += 5) {
      await metrics.recordHeartbeat("host-1", heartbeatAt(base + offset, offset), 30);
    }

    expect(samples.rows).toHaveLength(5);
    const stored = samples.rows as unknown as HostMetricSample[];
    expect(stored.map((row) => Math.floor(row.ts.getTime() / 1000) - base)).toEqual([0, 30, 60, 90, 120]);
    // Absolute bytes travel with the percentages, as bigint-safe strings.
    expect(stored[0]?.memUsedBytes).toBe(String(12 * 1024 ** 3));
  });

  it("[TC-PDMETRIC-006] serves a compact series and the latest byte counts", async () => {
    const now = new Date("2026-07-25T10:00:00Z");
    const base = Math.floor(now.getTime() / 1000);
    await metrics.recordHeartbeat("host-1", heartbeatAt(base - 60, 10), 30);
    await metrics.recordHeartbeat("host-1", heartbeatAt(base - 30, 20), 30);
    await metrics.recordHeartbeat("host-1", heartbeatAt(base, 30), 30);
    await metrics.recordHeartbeat("host-2", heartbeatAt(base, 99), 30);

    const series = await metrics.series("host-1", { windowSec: 120, stepSec: 30, now });
    expect(series.cpu).toEqual([null, null, 10, 20, 30]);

    const latest = await metrics.latest("host-1");
    expect(latest?.memTotalBytes).toBe(30 * 1024 ** 3);
    expect(latest?.swapTotalBytes).toBe(8 * 1024 ** 3);
  });

  it("[TC-PDMETRIC-007] stores a swapless host as 0, not as null", async () => {
    const now = new Date("2026-07-25T10:00:00Z");
    const base = Math.floor(now.getTime() / 1000);
    // What every container and every swap-off server sends: measured, and zero.
    await metrics.recordHeartbeat(
      "host-1",
      heartbeatAt(base, 30, { swapPct: 0, swapUsedBytes: 0, swapTotalBytes: 0 }),
      30,
    );

    const stored = samples.rows as unknown as HostMetricSample[];
    // ⚠ "0", NOT null. `clampPct` and `toBigintString` both keep a measured zero
    // today; a falsy check added to either would silently put this host back in the
    // "nobody could look" bucket, where an agent older than 0.1.16 already lives.
    expect(stored[0]?.swapPct).toBe(0);
    expect(stored[0]?.swapUsedBytes).toBe("0");
    expect(stored[0]?.swapTotalBytes).toBe("0");

    const latest = await metrics.latest("host-1");
    expect(latest?.swapTotalBytes).toBe(0);
    const series = await metrics.series("host-1", { windowSec: 120, stepSec: 30, now });
    expect(series.swap.at(-1)).toBe(0);
  });

  it("[TC-PDMETRIC-004] prunes only the samples past each organization's retention", async () => {
    const now = new Date("2026-07-25T10:00:00Z");
    const hosts = new FakeRepository<Host>();
    const settingRows = new FakeRepository<FleetSetting>();
    const settings = new FleetSettingsService(settingRows.asRepository());
    // org-long keeps 30 days; org-short falls back to the 7-day default.
    await settings.update("org-long", { metricRetentionDays: 30 });

    await hosts.save(hosts.create({ id: "host-long", organizationId: "org-long" }));
    await hosts.save(hosts.create({ id: "host-short", organizationId: "org-short" }));

    const day = 24 * 60 * 60 * 1000;
    for (const [hostId, ageDays] of [
      ["host-long", 20],
      ["host-long", 40],
      ["host-short", 3],
      ["host-short", 20],
    ] as const) {
      await samples.save(
        samples.create({ hostId, ts: new Date(now.getTime() - ageDays * day), cpuPct: 1 }),
      );
    }

    const retention = new MetricsRetentionService(hosts.asRepository(), settings, metrics);
    const result = await retention.runOnce(now);

    expect(result).toEqual({ scopes: 2, hosts: 2, deleted: 2 });
    const remaining = samples.rows as unknown as HostMetricSample[];
    expect(remaining).toHaveLength(2);
    expect(remaining.map((row) => row.hostId).sort()).toEqual(["host-long", "host-short"]);
    // The 20-day-old sample survives for the org that asked for 30 days and is gone
    // for the one on the 7-day default.
    const longAgeDays = (now.getTime() - (remaining.find((r) => r.hostId === "host-long")?.ts.getTime() ?? 0)) / day;
    expect(Math.round(longAgeDays)).toBe(20);
  });
});
