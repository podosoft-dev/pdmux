import { Worker, type Processor } from "bullmq";
import { DataSource } from "typeorm";
import { auditEnabled } from "../audit/audit-enabled";
import { AuditService } from "../audit/audit.service";
import { configureAuthQueryDatabase } from "../auth/db";
import { validateEnv } from "../config/env.validation";
import { Database } from "../database/database";
import { dataSourceOptions } from "../database/data-source";
import { initializeApplicationDataSource } from "../database/schema-readiness";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "../hosts/host.entity";
import { StaleHostsProcessor } from "../hosts/stale-hosts.processor";
import { StaleHostsService } from "../hosts/stale-hosts.service";
import { STALE_HOSTS_QUEUE } from "../hosts/stale-hosts.queue";
import { HostMetricSample } from "../metrics/host-metric-sample.entity";
import { MetricsRetentionProcessor } from "../metrics/metrics-retention.processor";
import { MetricsRetentionService } from "../metrics/metrics-retention.service";
import { METRICS_QUEUE } from "../metrics/metrics.queue";
import { MetricsService } from "../metrics/metrics.service";
import { processDemoJob } from "./demo.processor";
import { DEMO_QUEUE, redisConnection } from "./queue";
// podokit:begin:worker-imports
// podokit:end:worker-imports

interface WorkerDefinition {
  queue: string;
  processor: Processor;
}

export interface WorkerRuntime {
  workers: Worker[];
  close: () => Promise<void>;
}

export async function startWorkers(): Promise<WorkerRuntime> {
  const dataSource = new DataSource(dataSourceOptions);
  await initializeApplicationDataSource(dataSource);
  const settings = new FleetSettingsService(dataSource.getRepository(FleetSetting));
  const metrics = new MetricsService(dataSource.getRepository(HostMetricSample));
  const stale = new StaleHostsProcessor(
    new StaleHostsService(dataSource.getRepository(Host), settings),
  );
  const retention = new MetricsRetentionProcessor(
    new MetricsRetentionService(dataSource.getRepository(Host), settings, metrics),
  );
  const database = new Database(validateEnv(process.env));
  // The audit toggle is read through the auth settings store, as in the API.
  configureAuthQueryDatabase(database.sql);
  // Retention pruning stays with the API; the worker only records.
  const audit = new AuditService(database.sql, { dialect: database.provider, enabled: auditEnabled });
  audit.connect();

  const definitions: WorkerDefinition[] = [
    { queue: DEMO_QUEUE, processor: processDemoJob },
    { queue: STALE_HOSTS_QUEUE, processor: () => stale.process() },
    { queue: METRICS_QUEUE, processor: () => retention.process() },
  ];
  const workers = definitions.map(({ queue, processor }) =>
    new Worker(queue, processor, { connection: redisConnection() })
  );
  return {
    workers,
    close: async (): Promise<void> => {
      await Promise.all(workers.map((worker) => worker.close()));
      await audit.close();
      await Promise.all([dataSource.destroy(), database.close()]);
    },
  };
}
