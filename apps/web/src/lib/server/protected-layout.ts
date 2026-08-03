import { redirect } from "@sveltejs/kit";
import type { Capabilities } from "@podosoft/podokit-api-client";
import { requireBackendAvailable } from "./guards";

type ServerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProtectedLayoutInput {
  locals: App.Locals;
  fetch: ServerFetch;
}

export interface ProtectedLayoutData {
  user: App.Locals["user"];
  impersonating: boolean;
  capabilities: Capabilities;
}

/**
 * Load the shared signed-in route context without imposing an application shell.
 * The `(app)` group stays available for product UI, while `(admin)` adds admin chrome.
 */
export async function loadProtectedLayout({
  locals,
  fetch,
}: ProtectedLayoutInput): Promise<ProtectedLayoutData> {
  requireBackendAvailable(locals);

  let capabilities: Capabilities = {
    twoFactor: false,
    providers: [],
    deleteAccount: false,
    auditLog: false,
    emailVerification: false,
    signupApprovalRequired: false,
    passwordBreachCheck: false,
    magicLink: false,
    emailOtp: false,
    username: false,
    multiSession: false,
    phoneNumber: false,
    apiKey: false,
    passkey: false,
    organization: false,
    oidcProvider: false,
    roles: ["admin", "user"],
  };
  try {
    const response = await fetch("/api/account/capabilities");
    if (response.ok) capabilities = (await response.json()) as Capabilities;
  } catch {
    /* keep defaults */
  }

  // Require-two-factor policy: a signed-in user who has not enrolled is sent to
  // setup. The API guard remains authoritative; this redirect provides the UX.
  const user = locals.user as (App.Locals["user"] & { twoFactorEnabled?: boolean }) | null;
  let mustEnrol = false;
  if (user && !user.twoFactorEnabled) {
    try {
      const response = await fetch("/api/account/require-2fa");
      mustEnrol =
        response.ok &&
        ((await response.json()) as { require2fa?: boolean }).require2fa === true;
    } catch {
      /* do not block the app if the policy check fails */
    }
  }
  if (mustEnrol) redirect(302, "/setup-2fa");

  return {
    user: locals.user,
    impersonating: Boolean(locals.session?.impersonatedBy),
    capabilities,
  };
}
