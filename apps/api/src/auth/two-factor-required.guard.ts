import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { AppException } from "@podosoft/podokit-contracts";
import { FLAG_DEFAULTS } from "../settings/flag-defaults";
import { pool } from "./db";
import { auth } from "./auth";

/**
 * Enforces the "require two-factor" policy (admin Settings): while it is on, a
 * signed-in user who has not enrolled in 2FA is blocked from every app route
 * until they do — the security boundary behind the web enrolment gate (the web
 * redirect is only UX).
 *
 * Registered after the better-auth AuthGuard. Requests with no user session
 * (unauthenticated, or machine api-key/bearer calls) are not gated here — the
 * auth guard owns authentication. A short allow-list keeps the endpoints needed
 * to read the policy and enrol reachable; the 2FA enrol/verify endpoints live
 * under /api/auth/two-factor (better-auth), never behind this guard.
 *
 * `require2fa` is read from app_setting through a small TTL cache (self-contained,
 * so this global guard needs no DI), the same way auth/feature-gate.ts reads flags.
 */
@Injectable()
export class TwoFactorRequiredGuard implements CanActivate {
  // Reachable while gated: read the policy/capabilities, and — break-glass — the
  // admin-only flag toggle, so an admin who turned the policy on (and isn't yet
  // enrolled) can still turn it back off instead of being hard-locked.
  private static readonly ALLOW = [
    "/account/capabilities",
    "/account/require-2fa",
    "/account/settings",
    "/health",
  ];
  private static readonly TTL_MS = 3_000;
  private cached = FLAG_DEFAULTS.require2fa;
  private fetchedAt = 0;

  private async enforced(): Promise<boolean> {
    if (Date.now() - this.fetchedAt < TwoFactorRequiredGuard.TTL_MS) return this.cached;
    try {
      const res = await pool.query<{ value: string }>(
        'SELECT "value" FROM "app_setting" WHERE "key" = $1',
        ["require2fa"],
      );
      this.cached = res.rows[0]?.value === "true";
    } catch {
      this.cached = FLAG_DEFAULTS.require2fa;
    }
    this.fetchedAt = Date.now();
    return this.cached;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path || req.url || "";
    if (TwoFactorRequiredGuard.ALLOW.some((p) => path === p || path.startsWith(`${p}/`))) return true;
    if (!(await this.enforced())) return true;

    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    const user = session?.user as { twoFactorEnabled?: boolean } | undefined;
    if (!user) return true; // unauthenticated or non-session (machine) request
    if (user.twoFactorEnabled) return true;

    throw new AppException("TWO_FACTOR_REQUIRED", "Two-factor enrolment is required.", 403);
  }
}
