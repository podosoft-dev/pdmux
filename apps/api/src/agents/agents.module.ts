import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { FleetModule } from "../fleet/fleet.module";
import { GitModule } from "../git/git.module";
import { HostsModule } from "../hosts/hosts.module";
import { MetricsModule } from "../metrics/metrics.module";
import { AgentAckService } from "./agent-ack.service";
import { AgentAuthFailure } from "./agent-auth-failure.entity";
import { AgentAuthFailuresController } from "./agent-auth-failures.controller";
import { AgentAuthFailuresService } from "./agent-auth-failures.service";
import { AgentCommandsController } from "./agent-commands.controller";
import { AgentConfigPushService } from "./agent-config-push.service";
import { AgentConfigService } from "./agent-config.service";
import { AgentDisconnectService } from "./agent-disconnect.service";
import { AgentDetailRequestService } from "./agent-detail-request.service";
import { AgentEnrollController } from "./agent-enroll.controller";
import { AgentEnrollment } from "./agent-enrollment.entity";
import { AgentEnrollmentsController } from "./agent-enrollments.controller";
import { AgentEnrollmentsService } from "./agent-enrollments.service";
import { AgentGateway } from "./agent.gateway";
import { AgentIngestService } from "./agent-ingest.service";
import { AgentExecService } from "./agent-exec.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentReleaseModule } from "./agent-release.module";
import { AgentUpdateController, FleetAgentUpdateController } from "./agent-update.controller";
import { AgentUpdateService } from "./agent-update.service";
import { AgentToken } from "./agent-token.entity";
import { AgentTokensController } from "./agent-tokens.controller";
import { AgentTokensService } from "./agent-tokens.service";

/** Token lifecycle, the enrollment codes the installer trades for one, and the
 *  WebSocket the agents dial. */
@Module({
  imports: [
    TypeOrmModule.forFeature([AgentToken, AgentEnrollment, AgentAuthFailure]),
    HostsModule,
    FleetModule,
    MetricsModule,
    GitModule,
    EventsModule,
    AgentReleaseModule,
  ],
  controllers: [
    AgentTokensController,
    AgentEnrollmentsController,
    AgentEnrollController,
    AgentAuthFailuresController,
    AgentCommandsController,
    AgentUpdateController,
    FleetAgentUpdateController,
  ],
  providers: [
    AgentTokensService,
    AgentEnrollmentsService,
    AgentAuthFailuresService,
    AgentRegistryService,
    AgentConfigService,
    AgentConfigPushService,
    AgentDisconnectService,
    AgentAckService,
    AgentExecService,
    AgentDetailRequestService,
    AgentIngestService,
    AgentUpdateService,
    AgentGateway,
  ],
  // The registry is what a terminal relay needs: one hostId -> socket map, one
  // sendToHost. Exported so the browser side can be wired without reaching in.
  // `AgentUpdateService` is exported for the MCP fleet surface, which offers the same
  // update the dashboard does rather than reimplementing the canary rule beside it.
  exports: [AgentRegistryService, AgentTokensService, AgentEnrollmentsService, AgentExecService, AgentUpdateService],
})
export class AgentsModule {}
