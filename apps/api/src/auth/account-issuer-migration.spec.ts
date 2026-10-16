import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  migrateLegacyAccountIssuers,
  migrateSqliteLegacyAccountIssuers,
  type AccountIssuerMigrationClient,
} from "./account-issuer-migration";

class AccountClient implements AccountIssuerMigrationClient {
  readonly statements: string[] = [];
  released = false;
  constructor(private readonly table = true, private readonly issuer = true, private readonly collisions = 0) {}
  async query<Row extends Record<string, unknown>>(sql: string): Promise<readonly Row[]> {
    this.statements.push(sql.trim());
    if (sql.includes("to_regclass")) return [{ exists: this.table }] as unknown as Row[];
    if (sql.includes("pg_attribute")) return [{ exists: this.issuer }] as unknown as Row[];
    if (sql.includes("AS collisions")) return [{ count: this.collisions }] as unknown as Row[];
    return [];
  }
  release(): void { this.released = true; }
}

async function migrate(client: AccountClient): Promise<string> {
  return migrateLegacyAccountIssuers({ connect: async (): Promise<AccountIssuerMigrationClient> => client });
}

function legacyDatabase(): Database {
  const database = new Database(":memory:");
  database.run('CREATE TABLE account (id text PRIMARY KEY, "providerId" text NOT NULL, "accountId" text NOT NULL, "userId" text NOT NULL, password text, issuer text NOT NULL)');
  database.run('CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account (issuer, "accountId")');
  database.run('INSERT INTO account VALUES (\'account\', \'credential\', \'user\', \'user\', \'password-hash\', \'local:credential\')');
  return database;
}

describe("Better Auth account identity cleanup", () => {
  it("leaves an absent PostgreSQL table to the auth migrator", async (): Promise<void> => {
    const client = new AccountClient(false);
    expect(await migrate(client)).toBe("absent");
    expect(client.statements.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });
  it("relaxes legacy PostgreSQL constraints without rewriting account data", async (): Promise<void> => {
    const client = new AccountClient();
    expect(await migrate(client)).toBe("migrated");
    expect(client.statements.some((sql) => sql.includes('ALTER COLUMN "issuer" DROP NOT NULL'))).toBe(true);
    expect(client.statements.some((sql) => sql.startsWith("UPDATE") || sql.startsWith("DELETE"))).toBe(false);
    expect(client.statements.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });
  it("does not add issuer to a current PostgreSQL schema", async (): Promise<void> => {
    const client = new AccountClient(true, false);
    expect(await migrate(client)).toBe("current");
    expect(client.statements.some((sql) => sql.includes("ADD COLUMN") || sql.includes("ALTER COLUMN"))).toBe(false);
  });
  it("rolls back PostgreSQL identity collisions before changing constraints", async (): Promise<void> => {
    const client = new AccountClient(true, true, 1);
    await expect(migrate(client)).rejects.toThrow("duplicate providerId and accountId");
    expect(client.statements.at(-1)).toBe("ROLLBACK");
    expect(client.statements.some((sql) => sql.startsWith("ALTER") || sql.startsWith("DROP"))).toBe(false);
    expect(client.released).toBe(true);
  });
  it("leaves an absent SQLite table to the auth migrator", (): void => {
    const database = new Database(":memory:");
    try { expect(migrateSqliteLegacyAccountIssuers(database)).toBe("absent"); }
    finally { database.close(); }
  });
  it("preserves SQLite accounts, accepts new rows without issuer, and can rerun", (): void => {
    const database = legacyDatabase();
    try {
      expect(migrateSqliteLegacyAccountIssuers(database)).toBe("migrated");
      expect(database.query('SELECT "userId", password FROM account').get()).toEqual({ userId: "user", password: "password-hash" });
      database.run('INSERT INTO account (id, "providerId", "accountId", "userId") VALUES (\'new\', \'github\', \'user\', \'user\')');
      expect(migrateSqliteLegacyAccountIssuers(database)).toBe("current");
      expect(database.query('SELECT count(*) AS count FROM account').get()).toEqual({ count: 2 });
      expect(() => database.run('INSERT INTO account (id, "providerId", "accountId", "userId") VALUES (\'duplicate\', \'github\', \'user\', \'other\')')).toThrow();
    } finally { database.close(); }
  });
  it("rolls back SQLite collisions without losing rows, issuer, or its index", (): void => {
    const database = legacyDatabase();
    try {
      database.run('INSERT INTO account VALUES (\'collision\', \'credential\', \'user\', \'other\', \'other-hash\', \'other-issuer\')');
      expect(() => migrateSqliteLegacyAccountIssuers(database)).toThrow("duplicate providerId and accountId");
      expect(database.query('SELECT count(*) AS count FROM account').get()).toEqual({ count: 2 });
      expect(database.query('SELECT issuer FROM account WHERE id = \'account\'').get()).toEqual({ issuer: "local:credential" });
      expect(database.query('SELECT name FROM sqlite_master WHERE name = \'account_issuer_accountId_uidx\'').get()).toBeTruthy();
    } finally { database.close(); }
  });
});
