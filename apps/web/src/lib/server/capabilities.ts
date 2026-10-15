import type { Capabilities } from "@podosoft/podokit-api-client";

type ServerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CapabilitiesEvent {
  locals: App.Locals;
  fetch: ServerFetch;
}

/** Safe values used when the capability endpoint cannot be reached. */
export const DEFAULT_CAPABILITIES: Capabilities = {
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
  require2fa: false,
  roles: ["admin", "user"],
};

async function fetchCapabilities(fetch: ServerFetch): Promise<Capabilities> {
  try {
    const response = await fetch("/api/account/capabilities");
    if (response.ok) return (await response.json()) as Capabilities;
  } catch {
    /* Keep safe defaults if the capability endpoint is unavailable. */
  }
  return DEFAULT_CAPABILITIES;
}

/**
 * Load `/account/capabilities` at most once per request. Every server load of
 * one page render or `__data.json` request shares `locals`, so layouts and
 * pages can call this freely. The promise never rejects; failures resolve to
 * {@link DEFAULT_CAPABILITIES}.
 */
export function getCapabilities({ locals, fetch }: CapabilitiesEvent): Promise<Capabilities> {
  locals.capabilities ??= fetchCapabilities(fetch);
  return locals.capabilities;
}
