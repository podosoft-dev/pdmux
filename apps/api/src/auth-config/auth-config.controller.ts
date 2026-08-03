import { Body, Controller, ForbiddenException, Get, Put } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { ApiTags } from "@nestjs/swagger";
import { AuthConfigService, type AuthConfigView, type AuthConfigUpdate } from "./auth-config.service";

function isAdmin(session: UserSession): boolean {
  const role = session.user?.role;
  const roles = Array.isArray(role) ? role : (role ?? "").split(",").map((r: string) => r.trim());
  return roles.includes("admin");
}

// Admin-only management of DB-backed auth config (OAuth providers, SMTP,
// server-enforced toggles). GET returns non-secret fields + `hasSecret`; PUT
// encrypts and stores secrets, and the change applies live (the auth instance
// rebuilds on the next request — see auth/auth-provider.ts). Secrets are never
// returned to the client.
@ApiTags("account")
@Controller("account")
export class AuthConfigController {
  constructor(private readonly service: AuthConfigService) {}

  @Get("auth-config")
  async get(@Session() session: UserSession): Promise<AuthConfigView> {
    if (!isAdmin(session)) throw new ForbiddenException("Admins only");
    return this.service.describe();
  }

  @Put("auth-config")
  async put(@Session() session: UserSession, @Body() body: AuthConfigUpdate): Promise<AuthConfigView> {
    if (!isAdmin(session)) throw new ForbiddenException("Admins only");
    return this.service.update(body);
  }
}
