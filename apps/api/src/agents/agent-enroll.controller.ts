import { Body, Controller, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "@thallesp/nestjs-better-auth";
import type { Request } from "express";
import { Audit } from "../audit/audit.decorator";
import { clientIp } from "../common/client-ip";
import { AgentEnrollmentsService, type EnrolledAgent } from "./agent-enrollments.service";
import { EnrollAgentDto } from "./dto/enroll-agent.dto";

/**
 * The audit entry for a redemption. The response contains a freshly minted token
 * plaintext, so only the identifiers are copied out — never `token`.
 */
const enrollTarget = (
  req: Request,
  result: unknown,
): { type: string; id?: string; label?: string; metadata: Record<string, unknown> } => {
  const enrolled = result as Partial<EnrolledAgent> | undefined;
  const body = (req as { body?: Partial<EnrollAgentDto> }).body ?? {};
  return {
    type: "host",
    id: enrolled?.hostId,
    label: enrolled?.hostLabel,
    metadata: {
      tokenId: enrolled?.tokenId,
      hostname: body.hostname ?? null,
      os: body.os ?? null,
      arch: body.arch ?? null,
      agentVersion: body.agentVersion ?? null,
    },
  };
};

@ApiTags("agents")
@Controller("agent")
export class AgentEnrollController {
  constructor(private readonly enrollments: AgentEnrollmentsService) {}

  /**
   * The installer's one call: trade a code for the host token it will keep.
   *
   * Public by necessity — the machine being installed has no session and no
   * credential yet; the code *is* the credential. The rate limit is what keeps
   * that from being an open guessing endpoint: 10 attempts per minute per client
   * address against a 100-bit space is not a search, it is a queue.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("enroll")
  @Audit("agent.enroll.redeem", enrollTarget)
  enroll(@Req() req: Request, @Body() dto: EnrollAgentDto): Promise<EnrolledAgent> {
    return this.enrollments.redeem(dto.code, clientIp(req));
  }
}
