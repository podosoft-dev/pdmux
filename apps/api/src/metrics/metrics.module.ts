import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FleetModule } from "../fleet/fleet.module";
import { HostsModule } from "../hosts/hosts.module";
import { redisConnection } from "../jobs/queue";
import { HostMetricSample } from "./host-metric-sample.entity";
import { MetricsController } from "./metrics.controller";
import { MetricsRetentionScheduler } from "./metrics-retention.scheduler";
import { MetricsRetentionService } from "./metrics-retention.service";
import { MetricsService } from "./metrics.service";
import { METRICS_QUEUE } from "./metrics.queue";

/**
 * API side: writes samples from heartbeats, serves the series, and registers the
 * repeatable prune job. The prune itself runs in the worker (see
 * metrics-worker.module.ts) so a large delete never shares a thread with a
 * terminal relay.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HostMetricSample]),
    BullModule.registerQueue({ name: METRICS_QUEUE, connection: redisConnection() }),
    FleetModule,
    HostsModule,
  ],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsRetentionService, MetricsRetentionScheduler],
  exports: [MetricsService, MetricsRetentionService],
})
export class MetricsModule {}
