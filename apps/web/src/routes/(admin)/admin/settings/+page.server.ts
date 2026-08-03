import type { PageServerLoad } from "./$types";
import { requireAdmin } from "$lib/server/guards";

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

export const load: PageServerLoad = async ({ locals, fetch }) => {
  requireAdmin(locals.user, locals);
  let authConfig: AuthConfigView | null = null;
  try {
    const res = await fetch("/api/account/auth-config");
    if (res.ok) authConfig = (await res.json()) as AuthConfigView;
  } catch {
    /* leave null — the page shows the DB-config sections as unavailable */
  }
  // The require-two-factor policy lives in the feature-flag store (not the typed
  // Capabilities), so read it from its own endpoint for the Settings toggle.
  let require2fa = false;
  try {
    const res = await fetch("/api/account/require-2fa");
    if (res.ok) require2fa = ((await res.json()) as { require2fa?: boolean }).require2fa === true;
  } catch {
    /* default off */
  }
  return { authConfig, require2fa };
};
