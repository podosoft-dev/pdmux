import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The administrator the admin-dashboard Playwright setup seeds, with the address
 * and password `accounts.ts` reads from `E2E_*` variables and the application's
 * `app-accounts.ts`, or null in an app without that module. Specs of modules
 * that do not require admin-dashboard sign in with this instead of importing
 * `accounts.ts`, which only admin-dashboard installs.
 */
export async function seededAdmin(): Promise<{ email: string; password: string } | null> {
  if (!existsSync(join(__dirname, "accounts.ts"))) return null;
  const { ADMIN } = await import("./accounts");
  return { email: ADMIN.email, password: ADMIN.password };
}
