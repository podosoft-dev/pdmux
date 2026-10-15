import { redirect } from "@sveltejs/kit";
import type { Capabilities } from "@podosoft/podokit-api-client";
import { getCapabilities, type CapabilitiesEvent } from "./capabilities";
import { requireBackendAvailable } from "./guards";

export type ProtectedLayoutInput = CapabilitiesEvent;

export interface ProtectedLayoutData {
  user: App.Locals["user"];
  impersonating: boolean;
  capabilities: Capabilities;
}

/**
 * Load the shared signed-in route context without imposing an application shell.
 * The `(app)` group stays available for product UI, while `(admin)` adds admin chrome.
 */
export async function loadProtectedLayout(event: ProtectedLayoutInput): Promise<ProtectedLayoutData> {
  const { locals } = event;
  requireBackendAvailable(locals);

  const capabilities = await getCapabilities(event);

  // Require-two-factor policy: a signed-in user who has not enrolled is sent to
  // setup. The API guard remains authoritative; this redirect provides the UX.
  if (locals.user && !locals.user.twoFactorEnabled && capabilities.require2fa) {
    redirect(302, "/setup-2fa");
  }

  return {
    user: locals.user,
    impersonating: Boolean(locals.session?.impersonatedBy),
    capabilities,
  };
}
