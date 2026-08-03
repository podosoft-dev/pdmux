import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { CreateHostDto } from "./dto/create-host.dto";
import { MoveHostDto } from "./dto/move-host.dto";
import { ReorderHostsDto } from "./dto/reorder-hosts.dto";
import { SetEnabledDto } from "./dto/set-enabled.dto";
import { UpdateHostDto } from "./dto/update-host.dto";
import type { Host } from "./host.entity";
import type { HostView } from "./host-view";
import { HostsService, type CreatedHost } from "./hosts.service";

/** Audit target resolver shared by the host mutations. */
const hostTarget = (_req: unknown, result: unknown): { type: string; id?: string; label?: string } => {
  const host = result as Partial<Host> | undefined;
  return { type: "host", id: host?.id, label: host?.label };
};

/**
 * Registration additionally records THAT a code was issued, and which row it is.
 *
 * Never the code itself: the plaintext exists in exactly one response body, and an
 * audit entry is the one place it would become permanent (same rule as
 * `tokenTarget`). `enrollmentIssued: false` is worth recording too — it is the
 * trace of a host that was registered without one.
 */
const createdHostTarget = (
  req: unknown,
  result: unknown,
): { type: string; id?: string; label?: string; metadata: Record<string, unknown> } => {
  const created = result as Partial<CreatedHost> | undefined;
  return {
    ...hostTarget(req, created),
    metadata: {
      enrollmentIssued: Boolean(created?.enrollment),
      enrollmentId: created?.enrollment?.id ?? null,
    },
  };
};

@ApiTags("hosts")
@Controller("hosts")
export class HostsController {
  constructor(private readonly hosts: HostsService) {}

  /** Everything the sidebar needs in one request: rows, services, probe status. */
  @Get()
  list(@Session() session: UserSession): Promise<HostView[]> {
    return this.hosts.list(resolveScopeId(session));
  }

  @Get(":id")
  get(@Session() session: UserSession, @Param("id", ParseUUIDPipe) id: string): Promise<HostView> {
    return this.hosts.getView(resolveScopeId(session), id);
  }

  /**
   * Registers the host and hands back a live enrollment code with it.
   *
   * `assertCanManageFleet` stays outside the promise (every handler here throws
   * synchronously for a non-admin), and `enrollment` may be `null` — a code that
   * could not be minted must not cost the operator the host.
   */
  @Post()
  @Audit("host.create", createdHostTarget)
  create(@Session() session: UserSession, @Body() dto: CreateHostDto): Promise<CreatedHost> {
    assertCanManageFleet(session);
    return this.hosts.createWithEnrollment(resolveScopeId(session), dto, session.user?.id ?? null);
  }

  @Patch(":id")
  @Audit("host.update", hostTarget)
  update(
    @Session() session: UserSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateHostDto,
  ): Promise<Host> {
    assertCanManageFleet(session);
    return this.hosts.update(resolveScopeId(session), id, dto);
  }

  @Delete(":id")
  @Audit("host.delete", hostTarget)
  remove(
    @Session() session: UserSession,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ id: string; label: string }> {
    assertCanManageFleet(session);
    return this.hosts.remove(resolveScopeId(session), id);
  }

  @Put(":id/enabled")
  @Audit("host.enable", hostTarget)
  setEnabled(
    @Session() session: UserSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetEnabledDto,
  ): Promise<Host> {
    assertCanManageFleet(session);
    return this.hosts.setEnabled(resolveScopeId(session), id, dto.enabled);
  }

  /**
   * Hand a host to another account.
   *
   * ⚠ ONLY OUT OF YOUR OWN SCOPE. `hosts.get(resolveScopeId(session), id)` inside
   * the service is the gate — a host you cannot see answers 404, not 403, exactly
   * as every other route does (REQ-PDHOST-002).
   */
  @Post(":id/move")
  @Audit("host.move", (req, result) => ({
    type: "host",
    id: (result as Host | undefined)?.id,
    label: (result as Host | undefined)?.label,
    // The destination belongs in the trail: this is the one action whose whole
    // point is that the row leaves the actor's own scope.
    metadata: { targetEmail: (req as { body?: { targetEmail?: string } }).body?.targetEmail },
  }))
  moveHost(
    @Session() session: UserSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: MoveHostDto,
  ): Promise<Host> {
    assertCanManageFleet(session);
    return this.hosts.move(resolveScopeId(session), id, dto.targetEmail);
  }

  @Put("reorder")
  @Audit("host.reorder", (_req, result) => ({
    type: "host",
    metadata: { order: (result as HostView[]).map((h) => h.id) },
  }))
  reorder(@Session() session: UserSession, @Body() dto: ReorderHostsDto): Promise<HostView[]> {
    assertCanManageFleet(session);
    return this.hosts.reorder(resolveScopeId(session), dto.ids);
  }
}
