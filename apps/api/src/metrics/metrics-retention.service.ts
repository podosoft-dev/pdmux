import { ProductLogger } from "../logging/product-logger";
import { Repository } from "typeorm";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "../hosts/host.entity";
import { retentionCutoff } from "./metric-series";
import { MetricsService } from "./metrics.service";

export interface RetentionRun {
  scopes: number;
  hosts: number;
  deleted: number;
}

/**
 * Deletes metric history past each organization's retention window.
 *
 * PER-SCOPE, NOT GLOBAL: retention is an organization setting, so one tenant
 * asking for 30 days must not be truncated to another tenant's 7. The loop is
 * over organizations (tens), not hosts (hundreds), and each delete is one
 * indexed range statement.
 */
export class MetricsRetentionService {
  private readonly logger = new ProductLogger(MetricsRetentionService.name);

  constructor(
    private readonly hosts: Repository<Host>,
    private readonly settings: FleetSettingsService,
    private readonly metrics: MetricsService,
  ) {}

  async runOnce(now: Date = new Date()): Promise<RetentionRun> {
    const rows = await this.hosts.find({ select: { id: true, organizationId: true } });
    const byScope = new Map<string, string[]>();
    for (const row of rows) {
      const list = byScope.get(row.organizationId) ?? [];
      list.push(row.id);
      byScope.set(row.organizationId, list);
    }

    let deleted = 0;
    for (const [organizationId, hostIds] of byScope) {
      const { metricRetentionDays } = await this.settings.resolve(organizationId);
      const cutoff = retentionCutoff(now, metricRetentionDays);
      deleted += await this.metrics.pruneHosts(hostIds, cutoff);
    }
    if (deleted > 0) {
      this.logger.log(`Prune metric samples deleted=${deleted} scopes=${byScope.size}`);
    }
    return { scopes: byScope.size, hosts: rows.length, deleted };
  }
}
