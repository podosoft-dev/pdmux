import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { Audit } from "../audit/audit.decorator";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { CreateAgentEnrollmentDto } from "./dto/create-agent-enrollment.dto";
import {
  AgentEnrollmentsService,
  type AgentEnrollmentView,
  type MintedAgentEnrollment,
} from "./agent-enrollments.service";

/** Audit metadata never carries the code — only the row it belongs to. */
const enrollmentTarget = (
  _req: unknown,
  result: unknown,
): { type: string; id?: string; metadata: Record<string, unknown> } => {
  const row = result as Partial<AgentEnrollmentView> | undefined;
  return {
    type: "agent-enrollment",
    id: row?.id,
    metadata: { hostId: row?.hostId, expiresAt: row?.expiresAt },
  };
};

@ApiTags("hosts")
@Controller("hosts/:hostId/enrollments")
export class AgentEnrollmentsController {
  constructor(private readonly enrollments: AgentEnrollmentsService) {}

  /** Returns the plaintext code exactly once; it is unrecoverable afterwards. */
  @Post()
  @Audit("agent.enrollment.create", enrollmentTarget)
  create(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    // ⚠ POSSIBLY ABSENT, AND THAT IS NOT PARANOIA. This route took no body until
    // the expiry choice arrived, and under Express 5 `express.json()` leaves
    // `req.body` UNDEFINED for a request with no body — where Express 4 left `{}`.
    // A caller that has not been updated (the install dialog is one) would
    // otherwise turn a 201 into a 500 reading a property off undefined.
    @Body() dto: CreateAgentEnrollmentDto | undefined,
  ): Promise<MintedAgentEnrollment> {
    assertCanManageFleet(session);
    return this.enrollments.create(
      resolveScopeId(session),
      hostId,
      session.user?.id ?? null,
      dto?.tokenExpiresInDays ?? null,
    );
  }

  /**
   * State only — never the code. This is where an operator learns *which* failure
   * the installer hit, since the public endpoint answers every one of them with
   * the same 401.
   */
  @Get("current")
  current(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
  ): Promise<AgentEnrollmentView | null> {
    assertCanManageFleet(session);
    return this.enrollments.current(resolveScopeId(session), hostId);
  }

  @Delete(":id")
  @Audit("agent.enrollment.revoke", enrollmentTarget)
  revoke(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<AgentEnrollmentView> {
    assertCanManageFleet(session);
    return this.enrollments.revoke(resolveScopeId(session), hostId, id);
  }
}
