import { describe, expect, mock, test } from "bun:test";
import { APIError } from "better-auth/api";
import { createSessionRevoker, type RevokeUserSessionApi } from "./admin-sessions.revoker";

describe("createSessionRevoker", () => {
  test("revokes through the audited Better Auth admin endpoint as the caller", async () => {
    const revokeUserSession = mock<RevokeUserSessionApi["revokeUserSession"]>(async () => ({ success: true }));
    const headers = new Headers({ cookie: "admin-session=1" });

    await createSessionRevoker(() => ({ revokeUserSession }))("secret-token", headers);

    expect(revokeUserSession).toHaveBeenCalledWith({ body: { sessionToken: "secret-token" }, headers });
  });

  test("reports Better Auth refusals with the standard error shape", async () => {
    const revoker = createSessionRevoker(() => ({
      revokeUserSession: async (): Promise<unknown> => {
        throw new APIError("FORBIDDEN", { message: "You are not allowed to revoke users sessions" });
      },
    }));

    await expect(revoker("secret-token", new Headers()))
      .rejects.toMatchObject({ code: "ADMIN_SESSION_REVOKE_FAILED", statusCode: 403 });
  });
});
