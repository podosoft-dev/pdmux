import { AppException } from "@podosoft/podokit-contracts";
import { APIError } from "better-auth/api";
import type { SessionRevoker } from "./admin-sessions.routes";

export const ADMIN_SESSION_REVOKE_FAILED = "ADMIN_SESSION_REVOKE_FAILED";

export interface RevokeUserSessionApi {
  revokeUserSession(input: { body: { sessionToken: string }; headers: Headers }): Promise<unknown>;
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
