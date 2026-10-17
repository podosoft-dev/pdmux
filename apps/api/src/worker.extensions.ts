import { DataSource } from "typeorm";
import { auditEnabled } from "./audit/audit-enabled";
import { AuditService } from "./audit/audit.service";
import { configureAuthQueryDatabase } from "./auth/db";
import { validateEnv } from "./config/env.validation";
import { createDataSourceOptions } from "./database/app-data-source";
import { Database } from "./database/database";
import { initializeApplicationDataSource } from "./database/schema-readiness";
import { FleetSetting } from "./fleet/fleet-setting.entity";
import { FleetSettingsService } from "./fleet/fleet-settings.service";
import { Host } from "./hosts/host.entity";
import { StaleHostsProcessor } from "./hosts/stale-hosts.processor";
import { StaleHostsService } from "./hosts/stale-hosts.service";
import { STALE_HOSTS_QUEUE } from "./hosts/stale-hosts.queue";
import type { WorkerDefinition, WorkerSetup } from "./jobs/worker.module";
import { HostMetricSample } from "./metrics/host-metric-sample.entity";
import { MetricsRetentionProcessor } from "./metrics/metrics-retention.processor";
import { MetricsRetentionService } from "./metrics/metrics-retention.service";
import { METRICS_QUEUE } from "./metrics/metrics.queue";
import { MetricsService } from "./metrics/metrics.service";

// This owned file is never overwritten by `podo update`. The BullMQ worker
// process (`main-worker.ts`) consumes pdmux's maintenance queues next to
// PodoKit's; what the processors open is released after the workers stop.
export async function configureWorkers(setup: WorkerSetup): Promise<WorkerDefinition[]> {
  const dataSource = new DataSource(createDataSourceOptions());
  await initializeApplicationDataSource(dataSource);
  setup.onClose(() => dataSource.destroy());
  const settings = new FleetSettingsService(dataSource.getRepository(FleetSetting));
  const metrics = new MetricsService(dataSource.getRepository(HostMetricSample));
  const stale = new StaleHostsProcessor(new StaleHostsService(dataSource.getRepository(Host), settings));
  const retention = new MetricsRetentionProcessor(
    new MetricsRetentionService(dataSource.getRepository(Host), settings, metrics),
  );

  const database = new Database(validateEnv(process.env));
  setup.onClose(() => database.close());
  // The audit toggle is read through the auth settings store, as in the API.
  configureAuthQueryDatabase(database.sql);
  // Retention pruning stays with the API; the worker only records.
  const audit = new AuditService(database.sql, { dialect: database.provider, enabled: auditEnabled });
  audit.connect();
  setup.onClose(() => audit.close());

  return [
    { queue: STALE_HOSTS_QUEUE, processor: () => stale.process() },
    { queue: METRICS_QUEUE, processor: () => retention.process() },
  ];
}
