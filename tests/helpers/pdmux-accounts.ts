/**
 * The account the pdmux specs run as, with its own host and agent.
 *
 * The product specs write dashboard layout and fleet state as part of their assertions.
 * Keeping those writes on a dedicated account prevents a suite run from rearranging the
 * shared admin's screen or touching that account's machines. Like the seeded accounts in
 * accounts.ts, the password is a default the environment overrides
 * (`E2E_SUITE_ADMIN_PASSWORD`); a stack where the account already exists keeps its own.
 */
export const E2E_ADMIN = {
  name: "E2E Admin",
  email: "pdmux-e2e@example.com",
  password: process.env.E2E_SUITE_ADMIN_PASSWORD || "Podokit3e-Str0ng!pw",
};
export const e2eAdminState = "playwright/.auth/pdmux-e2e.json";
/** Where setup leaves the one-time plaintext token used by the isolated agent. */
export const e2eAgentToken = "playwright/.auth/pdmux-e2e-agent-token.txt";
