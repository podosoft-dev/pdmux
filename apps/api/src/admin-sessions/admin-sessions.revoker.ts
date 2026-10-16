import { AppException } from "@podosoft/podokit-contracts";
import { APIError } from "better-auth/api";
import type { OwnSessionRevoker } from "../account-sessions/account-sessions.routes";
import type { SessionRevoker } from "./admin-sessions.routes";

export const ADMIN_SESSION_REVOKE_FAILED = "ADMIN_SESSION_REVOKE_FAILED";
export const ACCOUNT_SESSION_REVOKE_FAILED = "ACCOUNT_SESSION_REVOKE_FAILED";

export interface RevokeUserSessionApi {
  revokeUserSession(input: { body: { sessionToken: string }; headers: Headers }): Promise<unknown>;
}

export interface RevokeSessionApi {
  revokeSession(input: { body: { token: string }; headers: Headers }): Promise<unknown>;
}

/**
 * Revokes through the Better Auth admin endpoint rather than deleting the row, so
 * its permission check and after-hooks (including the audit log) still run.
 */
export function createSessionRevoker(api: () => RevokeUserSessionApi): SessionRevoker {
  return async (sessionToken, headers) => {
    try {
      await api().revokeUserSession({ body: { sessionToken }, headers });
    } catch (error) {
      if (error instanceof APIError) {
        throw new AppException(ADMIN_SESSION_REVOKE_FAILED, error.message, error.statusCode);
      }
      throw error;
    }
  };
}

/**
 * Revokes one of the caller's own sessions through Better Auth's
 * `/revoke-session`, so its ownership check and after-hooks (including the
 * audit log's `session.revoke`) still run.
 */
export function createOwnSessionRevoker(api: () => RevokeSessionApi): OwnSessionRevoker {
  return async (token, headers) => {
    try {
      await api().revokeSession({ body: { token }, headers });
    } catch (error) {
      if (error instanceof APIError) {
        throw new AppException(ACCOUNT_SESSION_REVOKE_FAILED, error.message, error.statusCode);
      }
      throw error;
    }
  };
}
