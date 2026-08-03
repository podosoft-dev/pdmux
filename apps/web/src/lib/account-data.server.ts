import type { Capabilities } from "@podosoft/podokit-api-client";

type ServerFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const defaultCapabilities: Capabilities = {
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

export async function loadAccountData(locals: App.Locals, fetch: ServerFetch): Promise<{
  user: App.Locals["user"];
  currentSessionId: string | null;
  capabilities: Capabilities;
}> {
  let capabilities = defaultCapabilities;
  try {
    const response = await fetch("/api/account/capabilities");
    if (response.ok) capabilities = (await response.json()) as Capabilities;
  } catch {
    /* Keep safe defaults if the capability endpoint is unavailable. */
  }

  return {
    user: locals.user,
    currentSessionId: locals.session?.id ?? null,
    capabilities,
  };
}
