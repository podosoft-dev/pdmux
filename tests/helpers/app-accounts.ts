import type { Account } from "./accounts";

/**
 * The seeded accounts' names, addresses, or password sources when this
 * application's differ from the generated `admin@example.com` and
 * `user@example.com`. PodoKit creates this file once and never overwrites it.
 * `E2E_ADMIN_EMAIL`, `E2E_USER_EMAIL`, `E2E_ADMIN_PASSWORD`, and
 * `E2E_USER_PASSWORD` still win over what is set here.
 *
 * The seed signs the accounts up, so the API must promote the administrator:
 * list its address in `ADMIN_EMAILS`. For example, accounts named by the
 * application's own variables:
 *
 * ```ts
 * export const appAccounts: AppAccounts = {
 *   admin: { email: process.env.MYAPP_ADMIN_EMAIL, password: process.env.MYAPP_ADMIN_PASSWORD },
 * };
 * ```
 *
 * Never commit a real password here.
 */
export type AppAccounts = { admin?: Partial<Account>; user?: Partial<Account> };

export const appAccounts: AppAccounts = {};
