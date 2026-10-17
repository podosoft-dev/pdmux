import type { Account } from "./accounts";

type StorageState = { cookies: Cookie[]; origins: unknown[] };
type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/** The suite password, a default the environment overrides like the seeded accounts' in accounts.ts. */
const PASSWORD = process.env.E2E_SUITE_ADMIN_PASSWORD || "Podokit3e-Str0ng!pw";

/**
 * The account that owns the pdmux specs' organization, host and agent.
 *
 * The specs themselves run as `e2eWorker(parallelIndex)` (see `pdmux-test.ts`); this account
 * only sets their world up. It must be an administrator (listed in `ADMIN_EMAILS` before it
 * signs up): an organization's fleet is changed by administrators only, and it creates the
 * worker accounts as administrators for the same reason. A stack where the account already
 * exists keeps its own password; tell the suite with `E2E_SUITE_ADMIN_PASSWORD`.
 */
export const E2E_OWNER: Account = {
  name: "E2E Admin",
  email: "pdmux-e2e@example.com",
  password: PASSWORD,
};
export const e2eOwnerState = "playwright/.auth/pdmux-e2e.json";
/** Where setup leaves the one-time plaintext token used by the isolated agent. */
export const e2eAgentToken = "playwright/.auth/pdmux-e2e-agent-token.txt";

/**
 * The account Playwright worker `index` (its `parallelIndex`) signs in as.
 *
 * WHY ONE PER WORKER: the specs write per-user state as part of what they assert — the
 * dashboard layout, the sidebar, host preferences. On one shared account, two workers
 * overwrote each other's layout and a different test failed on every `E2E_WORKERS=2` run.
 * Every worker account is a member of the owner's organization, and fleet rows are scoped
 * per organization, so they all see the same host and agent.
 */
export function e2eWorker(index: number): Account {
  return { name: `E2E Worker ${index}`, email: `pdmux-e2e-w${index}@example.com`, password: PASSWORD };
}

export function e2eWorkerState(index: number): string {
  return `playwright/.auth/pdmux-e2e-w${index}.json`;
}

/** The session with its locale pinned to English, because UI locators use the English catalog. */
export function withEnglishLocale<T extends StorageState>(state: T, base: string): T {
  const url = new URL(base);
  return {
    ...state,
    cookies: [
      ...state.cookies.filter((cookie) => cookie.name !== "locale"),
      {
        name: "locale",
        value: "en",
        domain: url.hostname,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      },
    ],
  };
}
