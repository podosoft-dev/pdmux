import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { CreateHostGitRootDto, UpdateHostGitRootDto } from "./dto/host-git-root.dto";
import type { HostGitRoot } from "./host-git-root.entity";
import { HostGitRootsService } from "./host-git-roots.service";

/**
 * ⚠ THE AUDIT LABEL IS THE PATH, and that is deliberate: a git root is a place on
 * somebody's machine, so "who pointed the fleet at /home/alice" is exactly the
 * question an audit trail has to answer here. It is not a credential — the same
 * path is already visible on the host page to anyone who can see the host.
 */
const rootTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string } => {
  const root = result as Partial<HostGitRoot> | undefined;
  return { type: "host-git-root", id: root?.id, label: root?.path };
};

@ApiTags("hosts")
@Controller("hosts/:hostId/git-roots")
export class HostGitRootsController {
  constructor(private readonly roots: HostGitRootsService) {}

  @Get()
  list(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
  ): Promise<HostGitRoot[]> {
    return this.roots.list(resolveScopeId(session), hostId);
  }

  @Post()
  @Audit("host.gitroot.create", rootTarget)
  create(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Body() dto: CreateHostGitRootDto,
  ): Promise<HostGitRoot> {
    assertCanManageFleet(session);
    return this.roots.create(resolveScopeId(session), hostId, dto);
  }

  @Patch(":id")
  @Audit("host.gitroot.update", rootTarget)
  update(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateHostGitRootDto,
  ): Promise<HostGitRoot> {
    assertCanManageFleet(session);
    return this.roots.update(resolveScopeId(session), hostId, id, dto);
  }

  @Delete(":id")
  @Audit("host.gitroot.delete", rootTarget)
  remove(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ id: string; path: string }> {
    assertCanManageFleet(session);
    return this.roots.remove(resolveScopeId(session), hostId, id);
  }
}
