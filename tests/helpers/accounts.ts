export type Account = { name: string; email: string; password: string };

/**
 * The password the suite signs in with, per account.
 *
 * A test must never change an existing account's credentials. `seed.setup.ts` signs up
 * idempotently and then signs in with these values, which is right on a stack the suite
 * created — and wrong on every stack where the account already exists with a password of
 * its own. An install bootstrapped with `admin:bootstrap` is exactly that: `admin@example.com`
 * is a real account somebody logs in as, and resetting it to match the constant takes their
 * login with it while the run goes green.
 *
 * So the constant is a DEFAULT and the environment wins:
 *
 * ```bash
 * E2E_BASE_URL=https://app.example.com E2E_ADMIN_PASSWORD='…' bunx --bun playwright test …
 * ```
 *
 * Without the override the run fails with `INVALID_EMAIL_OR_PASSWORD`, which is the correct
 * outcome — a refusal, not a silent overwrite. Do not commit a real value here.
 */
function seedPassword(envVar: "E2E_ADMIN_PASSWORD" | "E2E_USER_PASSWORD"): string {
  const value = process.env[envVar];
  return value !== undefined && value.length > 0 ? value : "Podokit3e-Str0ng!pw";
}

export const ADMIN = { name: "Admin", email: "admin@example.com", password: seedPassword("E2E_ADMIN_PASSWORD") };
export const USER = { name: "Normal User", email: "user@example.com", password: seedPassword("E2E_USER_PASSWORD") };
export const adminState = "playwright/.auth/admin.json";
export const userState = "playwright/.auth/user.json";
export const userBaselineState = "playwright/.auth/user-baseline.json";
const testUrl = new URL(process.env.E2E_BASE_URL ?? "http://localhost:5001");
export const anonState = {
  cookies: [
    {
      name: "locale",
      value: "en",
      domain: testUrl.hostname,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: testUrl.protocol === "https:",
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
};
