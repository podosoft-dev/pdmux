import { Body, Controller, ForbiddenException, Get, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { Public, Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { ApiTags } from "@nestjs/swagger";
import { FEATURE_FLAGS, SettingsService, type FeatureFlag } from "../settings/settings.service";
import { ROLE_NAMES } from "../auth/permissions";
import { auth } from "../auth/auth";
import { authConfigStore } from "../auth/auth-config-store";
import type { Capabilities } from "@podosoft/podokit-contracts";

function isAdmin(session: UserSession): boolean {
  const role = session.user?.role;
  const roles = Array.isArray(role) ? role : (role ?? "").split(",").map((r: string) => r.trim());
  return roles.includes("admin");
}

@ApiTags("account")
@Controller("account")
export class AccountController {
  constructor(private readonly settings: SettingsService) {}

  @Get("me")
  me(@Session() session: UserSession) {
    return session.user;
  }

  // The "require two-factor" policy, for the web enrolment gate. Kept out of the
  // typed Capabilities (that lives in a published package); allow-listed in
  // TwoFactorRequiredGuard so a not-yet-enrolled user can still read it.
  @Get("require-2fa")
  requireTwoFactor(): { require2fa: boolean } {
    return { require2fa: this.settings.getBool("require2fa") };
  }

  // Which optional auth features are enabled, so the UI can show/hide sections.
  // Public so the login page (unauthenticated) can offer available sign-in methods.
  @Public()
  @Get("capabilities")
  async capabilities(): Promise<Capabilities> {
    const flags = this.settings.flags();
    // OAuth providers + server-enforced toggles are DB-backed (env fallback) and
    // applied live, so read them from the config store rather than process.env.
    const snapshot = await authConfigStore.capabilitiesSnapshot();
    return {
      twoFactor: flags.twoFactor,
      magicLink: flags.magicLink,
      emailOtp: flags.emailOtp,
      username: flags.username,
      multiSession: flags.multiSession,
      phoneNumber: flags.phoneNumber,
      apiKey: flags.apiKey,
      passkey: flags.passkey,
      organization: flags.organization,
      oidcProvider: flags.oidcProvider,
      providers: snapshot.providers,
      deleteAccount: snapshot.allowDelete,
      emailVerification: snapshot.requireEmailVerification,
      signupApprovalRequired: snapshot.requireSignupApproval,
      passwordBreachCheck: snapshot.passwordBreachCheck,
      auditLog: snapshot.auditLog,
      sessionIdleTimeoutMinutes: snapshot.sessionIdleTimeoutMinutes,
      roles: ROLE_NAMES,
    };
  }

  // Admin-only: toggle feature flags. Stored in the DB and reflected immediately in
  // capabilities (UI). Server-enforced behaviours (email verification, breach check)
  // are read by the auth server at startup, so those take effect on the next restart.
  @Put("settings")
  async updateSettings(
    @Session() session: UserSession,
    @Body() body: Partial<Record<FeatureFlag, boolean>>,
  ): Promise<Record<FeatureFlag, boolean>> {
    if (!isAdmin(session)) throw new ForbiddenException("Admins only");
    const update: Partial<Record<FeatureFlag, boolean>> = {};
    for (const flag of FEATURE_FLAGS) {
      if (typeof body?.[flag] === "boolean") update[flag] = body[flag];
    }
    return this.settings.setMany(update);
  }

  // Add an existing user to an organization with a role (e.g. "manager"), so several
  // members can hold it. better-auth's addMember is server-only; this exposes it and
  // delegates org-level authorization to better-auth via the caller's session headers.
  @Post("org-member")
  async addOrgMember(
    @Req() req: Request,
    @Body() body: { organizationId: string; userId: string; role: string },
  ): Promise<unknown> {
    // addMember is a server-only better-auth endpoint (not on the typed public api);
    // it exists at runtime, so reach it through a narrow cast.
    const api = auth.api as unknown as {
      addMember: (opts: { body: { organizationId: string; userId: string; role: string }; headers: Headers }) => Promise<unknown>;
    };
    return api.addMember({
      body: { organizationId: body.organizationId, userId: body.userId, role: body.role },
      headers: fromNodeHeaders(req.headers),
    });
  }
}
