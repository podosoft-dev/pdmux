import { AppException } from "@podosoft/podokit-contracts";
import type { AccessPolicy } from "../core/services";
import type { SettingsService } from "../settings/settings.service";
import { getAuth, refreshIfStale } from "./auth-provider";
import { closeAuthDatabase } from "./db";

export interface AuthUser extends Record<string, unknown> {
  id: string;
  role?: string | string[] | null;
  twoFactorEnabled?: boolean;
}

export interface AuthSession {
  user: AuthUser;
  session: Record<string, unknown>;
}

export type SessionResolver = (headers: Headers) => Promise<AuthSession | null>;

function defaultSessionResolver(headers: Headers): Promise<AuthSession | null> {
  return refreshIfStale()
    .then(() => getAuth().api.getSession({ headers }))
    .then((session) => session as AuthSession | null);
}

export function rolesOf(user: AuthUser): string[] {
  if (Array.isArray(user.role)) return user.role;
  return (user.role ?? "").split(",").map((role) => role.trim()).filter(Boolean);
}

export class AuthService {
  private readonly sessions = new WeakMap<Request, Promise<AuthSession | null>>();

  constructor(
    private readonly settings: SettingsService,
    private readonly accessPolicy: AccessPolicy,
    private readonly resolveSession: SessionResolver = defaultSessionResolver,
  ) {}

  session(request: Request): Promise<AuthSession | null> {
    const cached = this.sessions.get(request);
    if (cached) return cached;
    const result = this.resolveSession(request.headers);
    this.sessions.set(request, result);
    return result;
  }

  async requireSession(request: Request): Promise<AuthSession> {
    const session = await this.session(request);
    if (!session) throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
    return session;
  }

  async requireAdmin(request: Request): Promise<AuthSession> {
    const session = await this.requireSession(request);
    if (!rolesOf(session.user).includes("admin")) {
      throw new AppException("ADMIN_REQUIRED", "Administrator access is required", 403);
    }
    return session;
  }

  async guard(request: Request): Promise<void> {
    if (this.accessPolicy.resolve(request) !== "session") return;
    const session = await this.requireSession(request);
    if (!this.settings.getBool("require2fa") || session.user.twoFactorEnabled) return;
    const path = new URL(request.url).pathname;
    if (path === "/account/require-2fa" || path === "/account/settings") return;
    throw new AppException(
      "TWO_FACTOR_REQUIRED",
      "Two-factor enrolment is required.",
      403,
    );
  }

  async close(): Promise<void> {
    await closeAuthDatabase();
  }
}
