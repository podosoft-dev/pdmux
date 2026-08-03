import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import {
  AgentUpdateService,
  type AgentUpdateCommand,
  type FleetUpdateResult,
} from "./agent-update.service";
import { FleetUpdateAgentDto, UpdateAgentDto } from "./dto/update-agent.dto";

/**
 * "Replace yourself with this build" — one host, or a batch.
 *
 * TWO CONTROLLERS IN ONE FILE because they are one feature with two blast radii,
 * and reading them apart hides the only thing that differs: the fleet route
 * refuses to start at all unless some machine has already run the target build,
 * and it stops early. Splitting them across files would make that comparison a
 * navigation problem.
 *
 * Both are admin-only and audited. The audit target carries the `commandId`,
 * which is what ties a line in the log to the `updateStatus` frames that follow.
 */

const commandTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string; metadata: Record<string, unknown> } => {
  const command = result as Partial<AgentUpdateCommand> | undefined;
  return {
    type: "host",
    id: command?.hostId,
    label: command?.label,
    metadata: {
      commandId: command?.commandId,
      version: command?.version,
      sha256: command?.sha256,
    },
  };
};

@ApiTags("hosts")
@Controller("hosts/:hostId/agent")
export class AgentUpdateController {
  constructor(private readonly updates: AgentUpdateService) {}

  /** 409 when the host has no agent attached — a queued frame nobody reads is worse
   *  than an error, because the dashboard would report an update that never began. */
  @Post("update")
  @Audit("agent.update", commandTarget)
  async update(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: UpdateAgentDto,
  ): Promise<AgentUpdateCommand> {
    assertCanManageFleet(session);
    return this.updates.updateHost(resolveScopeId(session), hostId, {
      version: dto.version ?? null,
      force: dto.force ?? false,
    });
  }
}

@ApiTags("fleet")
@Controller("fleet/agent")
export class FleetAgentUpdateController {
  constructor(private readonly updates: AgentUpdateService) {}

  /**
   * Roll a build out to several hosts, bounded and abortable.
   *
   * Refuses with 409 `NO_CANARY` unless at least one host already runs the target
   * version — the canary is what turns "push to 40 machines" into "push to the
   * 39 that are not the one you already proved it on".
   */
  @Post("update")
  @Audit("agent.update.fleet", (_req, result) => {
    const outcome = result as Partial<FleetUpdateResult> | undefined;
    return {
      type: "fleet",
      metadata: {
        version: outcome?.version,
        requested: outcome?.requested,
        started: outcome?.started?.map((command) => command.hostId) ?? [],
        failed: outcome?.failed ?? [],
        notAttempted: outcome?.notAttempted ?? [],
        stopped: outcome?.stopped ?? false,
        summary: outcome?.summary,
      },
    };
  })
  async updateFleet(
    @Session() session: UserSession,
    @Body() dto: FleetUpdateAgentDto,
  ): Promise<FleetUpdateResult> {
    assertCanManageFleet(session);
    return this.updates.updateFleet(resolveScopeId(session), {
      hostIds: dto.hostIds,
      version: dto.version,
    });
  }
}
