import { describe, expect, it } from "bun:test";
import { SUPPORTED_SOCIAL_PROVIDERS } from "@podosoft/podokit-auth";
import {
  legacyAccountIssuer,
  legacyAccountIssuerTriggerSql,
  migrateLegacyAccountIssuers,
  type AccountIssuerMigrationClient,
  type AccountIssuerMigrationDatabase,
} from "./account-issuer-migration";

type Statement = { sql: string; values?: readonly unknown[] };
type LegacyAccountOptions = {
  tableExists?: boolean;
  column?: { dataType: string; isNullable: "YES" | "NO" };
  counts?: {
    blankIssuer?: number;
    credentialMismatch?: number;
    unresolvedIssuer?: number;
    collision?: number;
  };
};

class LegacyAccountClient implements AccountIssuerMigrationClient {
  readonly statements: Statement[] = [];
  released = false;

  constructor(
    private readonly providers: readonly string[],
    private readonly options: LegacyAccountOptions = {},
  ) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.statements.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes("information_schema.tables")) {
      return [{ exists: this.options.tableExists ?? true }] as unknown as Row[];
    }
    if (sql.includes("information_schema.columns")) {
      return (this.options.column ? [this.options.column] : []) as unknown as Row[];
    }
    if (sql.includes('SELECT DISTINCT "providerId"')) {
      return this.providers.map((providerId) => ({ providerId })) as unknown as Row[];
    }
    if (sql.includes('COUNT(*)::int AS "count"')) {
      const count = sql.includes('"accountId" <> "userId"')
        ? this.options.counts?.credentialMismatch
        : sql.includes("AS collisions")
          ? this.options.counts?.collision
          : sql.includes('"issuer" IS NULL OR')
            ? this.options.counts?.unresolvedIssuer
            : this.options.counts?.blankIssuer;
      return [{ count: count ?? 0 }] as unknown as Row[];
    }
    return [];
  }

  release(): void {
    this.released = true;
  }
}

function database(client: LegacyAccountClient): AccountIssuerMigrationDatabase {
  return { connect: async (): Promise<AccountIssuerMigrationClient> => client };
}

describe("Better Auth account issuer migration", () => {
  it("[TC-PDHOST-026] maps every safely derivable provider and refuses identities that need trusted external data", () => {
    expect(legacyAccountIssuer("credential")).toBe("local:credential");
    expect(legacyAccountIssuer("google")).toBe("https://accounts.google.com");
    expect(legacyAccountIssuer("apple")).toBe("https://appleid.apple.com");
    expect(legacyAccountIssuer("facebook")).toBe("https://www.facebook.com");
    expect(legacyAccountIssuer("line")).toBe("https://access.line.me");
    expect(legacyAccountIssuer("github")).toBe("local:oauth:github");
    expect(legacyAccountIssuer("microsoft")).toBeUndefined();
    expect(legacyAccountIssuer("unknown-provider")).toBeUndefined();

    for (const { id } of SUPPORTED_SOCIAL_PROVIDERS) {
      if (id !== "microsoft") expect(legacyAccountIssuer(id), id).toBeDefined();
    }
  });

  it("[TC-PDHOST-026] installs a fail-closed compatibility trigger for the release that is still serving", () => {
    const sql = legacyAccountIssuerTriggerSql();
    expect(sql).toContain("BEFORE INSERT");
    expect(sql).toContain('WHEN (NEW."issuer" IS NULL)');
    expect(sql).toContain("NEW.\"accountId\" := NEW.\"userId\"");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).not.toContain("WHEN 'microsoft'");
  });

  it("[TC-PDHOST-026] adds, backfills, validates, constrains, and indexes a legacy account table in one transaction", async () => {
    const client = new LegacyAccountClient(["credential", "google", "github"]);

    await expect(migrateLegacyAccountIssuers(database(client))).resolves.toBe("migrated");

    const statements = client.statements.map(({ sql }) => sql.trim());
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes('ADD COLUMN "issuer" text'))).toBe(true);
    expect(
      client.statements.some(
        ({ sql, values }) => sql.includes('UPDATE "account"') && values?.[0] === "local:credential",
      ),
    ).toBe(true);
    expect(
      client.statements.some(
        ({ sql, values }) => sql.includes('UPDATE "account"') && values?.[0] === "https://accounts.google.com",
      ),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("CREATE TRIGGER podokit_fill_legacy_account_issuer"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes('ALTER COLUMN "issuer" SET NOT NULL'))).toBe(true);
    expect(statements.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS'))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("[TC-PDHOST-026] rolls back instead of guessing a Microsoft or unknown issuer", async () => {
    const client = new LegacyAccountClient(["microsoft"]);

    await expect(migrateLegacyAccountIssuers(database(client))).rejects.toThrow(
      "Cannot infer a trusted Better Auth issuer for legacy provider microsoft",
    );

    expect(client.statements.map(({ sql }) => sql.trim())).toContain("ROLLBACK");
    expect(client.statements.some(({ sql }) => sql.includes('SET NOT NULL'))).toBe(false);
    expect(client.released).toBe(true);
  });

  it("[TC-PDHOST-026] leaves a fresh database to the normal migrator and protects a current schema", async () => {
    const absent = new LegacyAccountClient([], { tableExists: false });
    const current = new LegacyAccountClient([], {
      column: { dataType: "text", isNullable: "NO" },
    });

    await expect(migrateLegacyAccountIssuers(database(absent))).resolves.toBe("absent");
    await expect(migrateLegacyAccountIssuers(database(current))).resolves.toBe("current");

    expect(absent.statements.some(({ sql }) => sql.includes("CREATE TRIGGER"))).toBe(false);
    expect(current.statements.some(({ sql }) => sql.includes("CREATE TRIGGER"))).toBe(true);
    for (const client of [absent, current]) {
      expect(client.statements.at(-1)?.sql.trim()).toBe("COMMIT");
      expect(client.released).toBe(true);
    }
  });

  it("[TC-PDHOST-026] rolls back before constraints when credentials mismatch or identity keys collide", async () => {
    const mismatch = new LegacyAccountClient(["credential"], {
      counts: { credentialMismatch: 1 },
    });
    const collision = new LegacyAccountClient(["google"], {
      counts: { collision: 1 },
    });

    await expect(migrateLegacyAccountIssuers(database(mismatch))).rejects.toThrow(
      "accountId differs from the linked userId",
    );
    await expect(migrateLegacyAccountIssuers(database(collision))).rejects.toThrow(
      "collide on the new issuer and accountId identity key",
    );

    for (const client of [mismatch, collision]) {
      expect(client.statements.map(({ sql }) => sql.trim())).toContain("ROLLBACK");
      expect(client.statements.some(({ sql }) => sql.includes('SET NOT NULL'))).toBe(false);
      expect(client.released).toBe(true);
    }
  });
});
