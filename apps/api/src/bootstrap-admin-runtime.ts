// Bundled entry for scripts/bootstrap-admin.mjs. The build bundles only its
// top-level targets, so the script cannot import auth modules from dist directly.
// The command runs against a migrated schema and reports a missing table from its
// own query. Better Auth's asynchronous startup check would only race the
// connection the command closes when it finishes.
import "./auth/maintenance-command";
import { verifyPassword } from "better-auth/crypto";
import { auth } from "./auth/auth";
import { closeAuthDatabase, postgresPool, sqliteDatabase } from "./auth/db";

export interface BootstrapUser {
  id: string;
  email: string;
  role: string | null;
  emailVerified: boolean;
  signupApproved: boolean;
  passwordHash: string | null;
}

interface BootstrapUserRow extends Omit<BootstrapUser, "emailVerified" | "signupApproved"> {
  // SQLite stores booleans as 0 or 1.
  emailVerified: boolean | number | null;
  signupApproved: boolean | number | null;
}

function userQuery(placeholder: string): string {
  return `SELECT u.id,
                 u.email,
                 u.role,
                 u."emailVerified" AS "emailVerified",
                 u."signupApproved" AS "signupApproved",
                 a.password AS "passwordHash"
            FROM "user" AS u
       LEFT JOIN "account" AS a
              ON a."userId" = u.id
             AND a."providerId" = 'credential'
           WHERE lower(u.email) = lower(${placeholder})
           LIMIT 1`;
}

function flag(value: boolean | number | null): boolean {
  return value === true || value === 1;
}

export async function findBootstrapUser(email: string): Promise<BootstrapUser | null> {
  let row: BootstrapUserRow | undefined;
  if (postgresPool) {
    row = (await postgresPool.query<BootstrapUserRow>(userQuery("$1"), [email])).rows[0];
  } else if (sqliteDatabase) {
    row = sqliteDatabase.query<BootstrapUserRow, [string]>(userQuery("?1")).get(email) ?? undefined;
  }
  if (!row) return null;
  return {
    ...row,
    emailVerified: flag(row.emailVerified),
    signupApproved: flag(row.signupApproved),
  };
}

export { auth, closeAuthDatabase, verifyPassword };
