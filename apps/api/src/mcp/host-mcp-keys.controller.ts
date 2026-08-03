import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";

import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { CreateMcpKeyDto } from "./dto/create-mcp-key.dto";
import { HostMcpKeysService, type McpKeyView, type MintedMcpKey } from "./host-mcp-keys.service";

/** Audit metadata never carries the plaintext — only the row it belongs to. */
const keyTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string } => {
  const key = result as Partial<McpKeyView> | undefined;
  return { type: "mcp-key", id: key?.id, label: key?.label };
};

/**
 * Minting and revoking the credential an AI CLI uses.
 *
 * ⚠ THESE ROUTES ARE FOR A PERSON IN A BROWSER, NOT FOR A KEY. They take a session
 * and go through `assertCanManageFleet`, so a key can never mint another key — that
 * would turn one leaked credential into a permanent foothold, and revoking the
 * original would not close it.
 */
@ApiTags("hosts")
@Controller("hosts/:hostId/mcp-keys")
export class HostMcpKeysController {
  constructor(private readonly keys: HostMcpKeysService) {}

  @Get()
  list(@Session() session: UserSession, @Param("hostId", ParseUUIDPipe) hostId: string): Promise<McpKeyView[]> {
    assertCanManageFleet(session);
    return this.keys.list(resolveScopeId(session), hostId);
  }

  @Post()
  @Audit("mcp.key.create", keyTarget)
  create(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: CreateMcpKeyDto,
  ): Promise<MintedMcpKey> {
    assertCanManageFleet(session);
    return this.keys.mint(resolveScopeId(session), hostId, dto, session.user?.id ?? null);
  }

  @Delete(":id")
  @Audit("mcp.key.revoke", keyTarget)
  revoke(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<McpKeyView> {
    assertCanManageFleet(session);
    return this.keys.revoke(resolveScopeId(session), hostId, id);
  }
}
