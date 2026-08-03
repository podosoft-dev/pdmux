import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AgentReleaseModule } from "../agents/agent-release.module";
import { FleetModule } from "../fleet/fleet.module";
import { redisConnection } from "../jobs/queue";
import { HostGitRootsController } from "./host-git-roots.controller";
import { HostGitRootsService } from "./host-git-roots.service";
import { HostGitRoot } from "./host-git-root.entity";
import { HostServicesController } from "./host-services.controller";
import { HostServicesService } from "./host-services.service";
import { HostService } from "./host-service.entity";
import { Host } from "./host.entity";
import { HostsController } from "./hosts.controller";
import { HostsService } from "./hosts.service";
import { StaleHostsScheduler } from "./stale-hosts.scheduler";
import { STALE_HOSTS_QUEUE } from "./stale-hosts.queue";

// The API side only SCHEDULES the stale-host sweep; the deleting half runs in the
// worker (`hosts-worker.module.ts`), so a scope's worth of cascading deletes never
// shares a thread with a request that is relaying terminal bytes.
@Module({
  imports: [
    TypeOrmModule.forFeature([Host, HostService, HostGitRoot]),
    BullModule.registerQueue({ name: STALE_HOSTS_QUEUE, connection: redisConnection() }),
    FleetModule,
    AgentReleaseModule,
  ],
  controllers: [HostsController, HostServicesController, HostGitRootsController],
  providers: [HostsService, HostServicesService, HostGitRootsService, StaleHostsScheduler],
  exports: [HostsService, HostServicesService, HostGitRootsService, TypeOrmModule],
})
export class HostsModule {}
