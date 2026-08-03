import { pool } from "../auth/db";
import { createConfigStore } from "@podosoft/podokit-auth";

// Audit logging is an admin-managed, DB-backed server toggle (auth_config `server`
// row, env fallback AUDIT_LOG_ENABLED), read through the shared config store's
// short TTL cache — the same mechanism as the other server-enforced toggles.
// Toggling it on the Settings page takes effect within the cache TTL, no restart.
const store = createConfigStore(pool);

export async function auditEnabled(): Promise<boolean> {
  try {
    return (await store.capabilitiesSnapshot()).auditLog;
  } catch {
    return true; // never let a config read failure silently drop the audit trail
  }
}
