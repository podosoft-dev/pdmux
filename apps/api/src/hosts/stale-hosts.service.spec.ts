import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { setAuditRecorder, type AuditEntry } from "../audit/audit-events";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { FakeRepository } from "../testing/fake-repository";
import { Host } from "./host.entity";
import { staleCutoff } from "./stale-hosts";
import { StaleHostsService } from "./stale-hosts.service";

/**
 * Automatic host removal is the only thing in the product that deletes a host
 * nobody pointed at, and the delete cascades to the machine's tokens — so the
 * assertions here are mostly about what it REFUSES to touch.
 */
const NOW = new Date("2026-08-01T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("staleCutoff", () => {
  it("answers null for the shipped default, so a caller cannot sweep by accident", () => {
    // 0 is the off switch. If this returned `now` instead, every host in the
    // fleet would be strictly older than the cutoff.
    expect(staleCutoff(NOW, 0)).toBeNull();
    expect(staleCutoff(NOW, -5)).toBeNull();
    expect(staleCutoff(NOW, Number.NaN)).toBeNull();
  });

  it("puts the cutoff exactly N days back", () => {
    expect(staleCutoff(NOW, 30)?.toISOString()).toBe(daysAgo(30).toISOString());
  });
});

describe("StaleHostsService", () => {
  let hosts: FakeRepository<Host>;
  let settingRows: FakeRepository<FleetSetting>;
  let settings: FleetSettingsService;
  let audits: AuditEntry[];

  beforeEach(() => {
    hosts = new FakeRepository<Host>();
    settingRows = new FakeRepository<FleetSetting>();
    settings = new FleetSettingsService(settingRows.asRepository());
    audits = [];
    setAuditRecorder(async (entry) => {
      audits.push(entry);
    });
  });

  afterEach(() => {
    // Leave the shared registry as it was found — it is process-global.
    setAuditRecorder(async () => {});
  });

  function sweeper(): StaleHostsService {
    return new StaleHostsService(hosts.asRepository(), settings);
  }

  async function addHost(id: string, organizationId: string, lastSeenAt: Date | null): Promise<void> {
    await hosts.save(hosts.create({ id, organizationId, label: id, lastSeenAt }));
  }

  it("removes nothing until an operator opts in", async () => {
    await addHost("ancient", "org-a", daysAgo(400));
    await addHost("old", "org-a", daysAgo(90));

    const result = await sweeper().runOnce(NOW);

    // ⚠ THE POINT OF THE WHOLE FEATURE. Shipping this switched on would delete
    // hosts that were already past the window at the moment of upgrade, and the
    // cascade takes their tokens with them.
    expect(result).toEqual({ scopes: 1, armed: 0, removed: 0 });
    expect(hosts.rows).toHaveLength(2);
    expect(audits).toEqual([]);
  });

  it("removes only the hosts past their own scope's window", async () => {
    await settings.update("org-short", { staleHostRetentionDays: 30 });
    await settings.update("org-long", { staleHostRetentionDays: 365 });

    await addHost("short-fresh", "org-short", daysAgo(29));
    await addHost("short-stale", "org-short", daysAgo(31));
    // The same age, judged by a different scope's setting: it survives.
    await addHost("long-stale", "org-long", daysAgo(31));
    // A third scope never opted in at all.
    await addHost("off-ancient", "org-off", daysAgo(999));

    const result = await sweeper().runOnce(NOW);

    expect(result).toEqual({ scopes: 3, armed: 2, removed: 1 });
    expect((hosts.rows as unknown as Host[]).map((row) => row.id).sort()).toEqual([
      "long-stale",
      "off-ancient",
      "short-fresh",
    ]);
  });

  it("never removes a host that has not connected yet", async () => {
    await settings.update("org-a", { staleHostRetentionDays: 1 });
    // Registered a minute ago; the operator has not finished running the
    // installer. `lastSeenAt` is null, which is NOT "very old".
    await addHost("just-registered", "org-a", null);
    await addHost("really-stale", "org-a", daysAgo(5));

    const result = await sweeper().runOnce(NOW);

    expect(result.removed).toBe(1);
    expect((hosts.rows as unknown as Host[]).map((row) => row.id)).toEqual(["just-registered"]);
  });

  it("records every automatic deletion in the audit trail", async () => {
    await settings.update("org-a", { staleHostRetentionDays: 30 });
    await addHost("gone", "org-a", daysAgo(45));

    await sweeper().runOnce(NOW);

    // No actor: nobody pressed anything. The trail says WHY instead of inventing
    // a who — and it is the only remaining record that this host ever existed.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "host.prune",
      targetType: "host",
      targetId: "gone",
      targetLabel: "gone",
      metadata: {
        organizationId: "org-a",
        reason: "stale",
        retentionDays: 30,
        lastSeenAt: daysAgo(45).toISOString(),
      },
    });
    expect(audits[0]?.actorId ?? null).toBeNull();
  });
});
