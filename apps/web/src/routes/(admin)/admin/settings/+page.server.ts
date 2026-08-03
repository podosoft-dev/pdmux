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
  // Whether this server answers /mcp at all — same shape as require2fa, and for the
  // same reason: it is policy rather than a typed Capability, and that type lives in
  // a published package this repo cannot extend.
  //
  // ⚠ THIS IS THE DISPLAY PATH ONLY. Enforcement reads the same row through a
  // short-TTL pool query in `mcp/mcp-enabled.ts`, because SettingsService caches per
  // process and a switch honoured by one replica is not a switch.
  let mcpEnabled = true;
  try {
    const res = await fetch("/api/account/mcp-enabled");
    if (res.ok) mcpEnabled = ((await res.json()) as { mcpEnabled?: boolean }).mcpEnabled !== false;
  } catch {
    /* default on — a failed read must not read as "MCP is off" */
  }
  return { authConfig, require2fa, mcpEnabled };
};
