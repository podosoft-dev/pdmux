import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { CreateAgentTokenDto } from "./dto/create-agent-token.dto";
import {
  AgentTokensService,
  type AgentTokenView,
  type MintedAgentToken,
} from "./agent-tokens.service";

/** Audit metadata never carries the plaintext — only the row it belongs to. */
const tokenTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string } => {
  const token = result as Partial<AgentTokenView> | undefined;
  return { type: "agent-token", id: token?.id, label: token?.name };
};

@ApiTags("hosts")
@Controller("hosts/:hostId/tokens")
export class AgentTokensController {
  constructor(private readonly tokens: AgentTokensService) {}

  @Get()
  list(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
  ): Promise<AgentTokenView[]> {
    assertCanManageFleet(session);
    return this.tokens.list(resolveScopeId(session), hostId);
  }

  @Post()
  @Audit("agent.token.create", tokenTarget)
  create(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: CreateAgentTokenDto,
  ): Promise<MintedAgentToken> {
    assertCanManageFleet(session);
    return this.tokens.mint(resolveScopeId(session), hostId, dto.name, dto.expiresInDays ?? null);
  }

  @Post(":id/rotate")
  @Audit("agent.token.rotate", tokenTarget)
  rotate(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MintedAgentToken> {
    assertCanManageFleet(session);
    return this.tokens.rotate(resolveScopeId(session), hostId, id);
  }

  @Delete(":id")
  @Audit("agent.token.revoke", tokenTarget)
  revoke(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<AgentTokenView> {
    assertCanManageFleet(session);
    return this.tokens.revoke(resolveScopeId(session), hostId, id);
  }
}
