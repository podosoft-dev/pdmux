import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { IsIn } from "class-validator";
import { Audit } from "../audit/audit.decorator";
import { AppException } from "../common/app-exception";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { HostsService } from "../hosts/hosts.service";
import { AgentAckService } from "./agent-ack.service";
import { AgentRegistryService } from "./agent-registry.service";

export class CollectDto {
  /**
   * ⚠ `remote` LEAVES THE MACHINE, and the other two do not. It runs `ls-remote`,
   * which reads the remote's refs and writes nothing to the checkout — that is why
   * it can exist at all — but it waits on a network per repository, so it is never
   * on the agent's own timer and this endpoint is the only way it happens.
   */
  @IsIn(["heartbeat", "repos", "remote"])
  what!: "heartbeat" | "repos" | "remote";
}

@ApiTags("hosts")
@Controller("hosts/:hostId/collect")
export class AgentCommandsController {
  constructor(
    private readonly hosts: HostsService,
    private readonly registry: AgentRegistryService,
    private readonly ack: AgentAckService,
  ) {}

  /** "Refresh now" — ask the agent for a fresh pass instead of waiting for its interval. */
  @Post()
  @Audit("agent.collect", (_req, result) => ({
    type: "host",
    id: (result as { hostId: string }).hostId,
    metadata: { what: (result as { what: string }).what },
  }))
  async collect(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: CollectDto,
  ): Promise<{ hostId: string; what: string; ackFrames: number }> {
    assertCanManageFleet(session);
    const host = await this.hosts.get(resolveScopeId(session), hostId);
    if (!this.registry.isConnected(host.id)) {
      throw new AppException("HOST_OFFLINE", "No agent is connected to this host", 409);
    }
    // Ack before asking: the agent applies the ledger to the pass it is about to
    // run, so the budget goes to commits nobody has yet.
    const ackFrames = dto.what === "repos" ? await this.ack.ackAllRepos(host.id) : 0;
    this.registry.sendToHost(host.id, { type: "collect", what: dto.what });
    return { hostId: host.id, what: dto.what, ackFrames };
  }
}
