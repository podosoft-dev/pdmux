export type Account = { name: string; email: string; password: string };

/**
 * The password the suite signs in with, per account.
 *
 * ⚠ **THE SUITE MUST NEVER CHANGE AN EXISTING ACCOUNT'S CREDENTIALS.** `seed.setup.ts`
 * signs up idempotently and then signs in with these values, which is correct on a
 * stack the suite created — and wrong on every stack where the account already exists
 * with a password of its own. A local install bootstrapped with `admin:bootstrap` is
 * exactly that: `admin@example.com` is a real account somebody logs in as.
 *
 * Making the account match the constant "fixes" one run and takes that person's login
 * with it. So the constant is a DEFAULT and the environment wins:
 *
 * ```bash
 * E2E_BASE_URL=http://pdmux.localhost E2E_ADMIN_PASSWORD='…' npx playwright test …
 * ```
 *
 * Do not commit a real value here or in a checked-in env file — see the workspace's
 * secrets rule.
 */
function seedPassword(envVar: "E2E_ADMIN_PASSWORD" | "E2E_USER_PASSWORD" | "E2E_SUITE_ADMIN_PASSWORD"): string {
  const value = process.env[envVar];
  return value !== undefined && value.length > 0 ? value : "Podokit3e-Str0ng!pw";
}

export const ADMIN = { name: "Admin", email: "admin@example.com", password: seedPassword("E2E_ADMIN_PASSWORD") };
export const USER = { name: "Normal User", email: "user@example.com", password: seedPassword("E2E_USER_PASSWORD") };
/**
 * The account the pdmux specs run as — with its own host and its own agent.
 *
 * WHY NOT `ADMIN`: those specs write the dashboard layout (split mode, which cell holds
 * which session, whether the dock is open) because that IS the behaviour under test. Shared
 * with a person, a suite run rearranges their screen mid-session — reported twice: "my
 * 4-split became a 9-split" and "I changed a session, logged back in, and it was gone" (the
 * second was the suite's own restore step undoing a change made while it ran).
 *
 * Fleet rows are scoped per account (`personal:<userId>`), so isolation needs a host of its
 * own; `seed.setup.ts` registers one and mints a token, and a second agent process serves
 * it.
 */
export const E2E_ADMIN = {
  name: "E2E Admin",
  email: "pdmux-e2e@example.com",
  password: seedPassword("E2E_SUITE_ADMIN_PASSWORD"),
};
export const adminState = "playwright/.auth/admin.json";
export const userState = "playwright/.auth/user.json";
export const e2eAdminState = "playwright/.auth/pdmux-e2e.json";
/** Where the seed leaves the agent token for its host, so a runner can start the agent. */
export const e2eAgentToken = "playwright/.auth/pdmux-e2e-agent-token.txt";
/** Users that existed before the run, so the teardown only removes what the run created. */
export const userBaselineState = "playwright/.auth/user-baseline.json";
export const anonState = { cookies: [], origins: [] } as const;
