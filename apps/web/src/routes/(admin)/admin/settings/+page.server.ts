import type { PageServerLoad } from "./$types";
import { getCapabilities, type CapabilitiesEvent } from "#lib/server/capabilities.js";
import { requireAdmin } from "#lib/server/guards.js";

// Non-secret view of the DB-backed auth config (OAuth providers, SMTP, server
// toggles). Secrets are never sent — only a `hasSecret` flag per credential.
// `social` is dynamic: one entry per configured provider; `catalog` lists every
// provider that can be added.
export type SocialProviderView = { id: string; enabled: boolean; clientId: string; redirectURI: string; hasSecret: boolean };
export type AuthConfigView = {
  social: Record<string, SocialProviderView>;
  catalog: ReadonlyArray<{ id: string; label: string }>;
  smtp: { enabled: boolean; host: string; port: number; secure: boolean; user: string; from: string; hasSecret: boolean };
  server: {
    requireEmailVerification: boolean;
    requireSignupApproval: boolean;
    allowDelete: boolean;
    hibp: boolean;
    auditLog: boolean;
    sessionIdleTimeoutMinutes: number | null;
  };
};

async function loadAuthConfig(fetch: CapabilitiesEvent["fetch"]): Promise<AuthConfigView | null> {
  try {
    const res = await fetch("/api/account/auth-config");
    if (res.ok) return (await res.json()) as AuthConfigView;
  } catch {
    /* leave null — the page shows the DB-config sections as unavailable */
  }
  return null;
}

export const load: PageServerLoad = async ({ locals, fetch }) => {
  requireAdmin(locals.user, locals);
  // The admin layout loads the same capabilities in this request, so the
  // require-two-factor policy comes from that shared response.
  const [authConfig, capabilities] = await Promise.all([
    loadAuthConfig(fetch),
    getCapabilities({ locals, fetch }),
  ]);
  return { authConfig, require2fa: capabilities.require2fa };
};
