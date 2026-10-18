import type { AuthService } from "../../auth/auth.service";
import type { AccessPolicy } from "../../core/services";

/** Native sessions authenticate the local profile without inheriting web-only
 * enrolment policy from an older desktop database. */
export async function requireDesktopSession(auth: Pick<AuthService, "requireSession">, policy: Pick<AccessPolicy, "resolve">, request: Request): Promise<void> {
  if (policy.resolve(request) === "session") await auth.requireSession(request);
}
