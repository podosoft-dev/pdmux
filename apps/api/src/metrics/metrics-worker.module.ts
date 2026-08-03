import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { dataSourceOptions } from "../database/data-source";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "../hosts/host.entity";
import { HostMetricSample } from "./host-metric-sample.entity";
import { MetricsRetentionProcessor } from "./metrics-retention.processor";
import { MetricsRetentionService } from "./metrics-retention.service";
import { MetricsService } from "./metrics.service";
import { METRICS_QUEUE } from "./metrics.queue";

/**
 * Worker side of metrics retention. Self-contained (it brings its own TypeORM
 * connection) because the worker process boots only WorkerModule — importing the
 * API's module graph there would start an HTTP server and a second agent gateway.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSourceOptions),
    TypeOrmModule.forFeature([HostMetricSample, Host, FleetSetting]),
    BullModule.registerQueue({ name: METRICS_QUEUE }),
  ],
  providers: [MetricsService, MetricsRetentionService, MetricsRetentionProcessor, FleetSettingsService],
})
export class MetricsWorkerModule {}
