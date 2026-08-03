import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLog } from "../audit/audit-log.entity";
import { AuditService } from "../audit/audit.service";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { Host } from "./host.entity";
import { StaleHostsProcessor } from "./stale-hosts.processor";
import { StaleHostsService } from "./stale-hosts.service";
import { STALE_HOSTS_QUEUE } from "./stale-hosts.queue";

/**
 * Worker side of the stale-host sweep. Bootstrapped by `WorkerModule`, so the
 * deletes run in the worker process rather than on a thread that may be relaying
 * terminal bytes — the same placement as metric retention.
 *
 * ⚠ NO `TypeOrmModule.forRoot` HERE, DELIBERATELY. `MetricsWorkerModule` already
 * opens the worker process's connection, and `TypeOrmCoreModule` is `@Global()`,
 * so `forFeature` reaches it from anywhere in that graph. A second `forRoot` in
 * one process would open a second pool and leave two providers answering to the
 * same DataSource token. If metric retention ever leaves the worker, the root
 * moves up to `WorkerModule` — it does not get duplicated here.
 *
 * ⚠ `AuditService` IS LISTED ON PURPOSE. `recordAudit()` writes through a
 * registry that service populates in `onModuleInit`; without it in this graph
 * every automatic deletion would be a silent no-op in the trail, which is the one
 * thing this sweep must never be.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Host, FleetSetting, AuditLog]),
    BullModule.registerQueue({ name: STALE_HOSTS_QUEUE }),
  ],
  providers: [StaleHostsService, StaleHostsProcessor, FleetSettingsService, AuditService],
})
export class HostsWorkerModule {}
