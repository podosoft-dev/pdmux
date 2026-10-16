import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqliteLegacyAccountIssuers } from "../auth/account-issuer-migration";
import { initializeDesktopSchema } from "./desktop-schema";

function legacyDesktopDatabase(file: string): void {
  const database = new Database(file);
  try {
    database.run('CREATE TABLE account (id text PRIMARY KEY, "providerId" text NOT NULL, "accountId" text NOT NULL, "userId" text NOT NULL, password text, issuer text NOT NULL)');
    database.run('CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account (issuer, "accountId")');
    database.run("INSERT INTO account VALUES ('account', 'credential', 'user', 'user', 'password-hash', 'local:credential')");
  } finally {
    database.close();
  }
}

/** One desktop launch, in the order `src/migrate.ts` applies on the SQLite provider. */
async function launch(file: string): Promise<string> {
  const sql = new SQL(`sqlite://${file}`);
  try {
    await initializeDesktopSchema(sql);
  } finally {
    await sql.close();
  }
  const database = new Database(file);
  try {
    return migrateSqliteLegacyAccountIssuers(database);
  } finally {
    database.close();
  }
}

describe("[TC-PDHOST-026] desktop SQLite account upgrade", () => {
  it("drops the legacy issuer on the first launch, keeps the account, and reruns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdmux-desktop-"));
    const file = join(directory, "pdmux.sqlite");
    try {
      legacyDesktopDatabase(file);
      expect(await launch(file)).toBe("migrated");
      expect(await launch(file)).toBe("current");

      const database = new Database(file);
      try {
        expect(database.query('SELECT "userId", password FROM account').get())
          .toEqual({ userId: "user", password: "password-hash" });
        expect(database.query("SELECT count(*) AS count FROM app_setting").get())
          .not.toEqual({ count: 0 });
        database.run(`INSERT INTO account (id, "providerId", "accountId", "userId") VALUES ('new', 'github', 'user', 'user')`);
        expect(() => database.run(
          `INSERT INTO account (id, "providerId", "accountId", "userId") VALUES ('duplicate', 'github', 'user', 'other')`,
        )).toThrow();
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
