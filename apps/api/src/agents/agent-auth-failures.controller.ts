import { Controller, ForbiddenException, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";

import { AgentAuthFailuresService, type AgentAuthFailureView } from "./agent-auth-failures.service";

@ApiTags("agents")
@Controller("agent-auth-failures")
export class AgentAuthFailuresController {
  constructor(private readonly failures: AgentAuthFailuresService) {}

  /**
   * Which agents the gateway is turning away, and how often.
   *
   * ⚠ ADMINS ONLY, and the same check the audit log uses. The rows name hosts
   * across every scope and the addresses dialling them, which is fleet-wide
   * information — the refusal reason for somebody else's machine is not something a
   * member of one organisation gets to read.
   */
  @Get()
  recent(@Session() session: UserSession): Promise<AgentAuthFailureView[]> {
    if ((session.user as { role?: string | null }).role !== "admin") {
      throw new ForbiddenException("Admins only");
    }
    return this.failures.recent();
  }
}
