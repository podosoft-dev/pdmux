import { AppException } from "@podosoft/podokit-contracts";
import type { AccessPolicy, RequestIdentity, ResolvedSessions } from "../core/services";
import type { SettingsService } from "../settings/settings.service";
import { getAuth, refreshForRequest } from "./auth-provider";
import { rethrowAuthError } from "./database-outage";
import { authDatabaseReachable, closeAuthDatabase } from "./db";

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
  return refreshForRequest()
    .then(() => getAuth().api.getSession({ headers }))
    .then(
      (session) => session as AuthSession | null,
      (error: unknown) => rethrowAuthError(error, authDatabaseReachable),
    );
}

export function rolesOf(user: AuthUser): string[] {
  if (Array.isArray(user.role)) return user.role;
  return (user.role ?? "").split(",").map((role) => role.trim()).filter(Boolean);
}

function activeOrganizationOf(session: AuthSession): string | undefined {
  const value = session.session.activeOrganizationId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export interface AuthServiceOptions {
  /** Looks a request's session up; Better Auth's getSession by default. */
  resolveSession?: SessionResolver;
  /** Receives every session this service resolves, such as for the rate limiter. */
  resolvedSessions?: ResolvedSessions;
}

export class AuthService {
  private readonly sessions = new WeakMap<Request, Promise<AuthSession | null>>();
  private readonly resolveSession: SessionResolver;
  private readonly resolvedSessions: ResolvedSessions | undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly accessPolicy: AccessPolicy,
    options: AuthServiceOptions = {},
  ) {
    this.resolveSession = options.resolveSession ?? defaultSessionResolver;
    this.resolvedSessions = options.resolvedSessions;
  }

  session(request: Request): Promise<AuthSession | null> {
    const cached = this.sessions.get(request);
    if (cached) return cached;
    const result = this.resolveSession(request.headers).then((session) => {
      if (session) this.report(session);
      return session;
    });
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
    if (session.user.twoFactorEnabled || !(await this.settings.getBool("require2fa"))) return;
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

  private report(session: AuthSession): void {
    const { token, expiresAt } = session.session;
    const expires = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt));
    if (!this.resolvedSessions || typeof token !== "string" || Number.isNaN(expires.getTime())) return;
    this.resolvedSessions.report({ token, userId: session.user.id, expiresAt: expires });
  }
}

/** Answers identity questions for other modules from the one session lookup memoized per request. */
export function createRequestIdentity(auth: AuthService): RequestIdentity {
  return {
    userId: async (request) => (await auth.session(request))?.user.id,
    isAdmin: async (request) => {
      const session = await auth.session(request);
      return session !== null && rolesOf(session.user).includes("admin");
    },
    roles: async (request) => {
      const session = await auth.session(request);
      return session ? rolesOf(session.user) : [];
    },
    activeOrganizationId: async (request) => {
      const session = await auth.session(request);
      return session ? activeOrganizationOf(session) : undefined;
    },
  };
}
