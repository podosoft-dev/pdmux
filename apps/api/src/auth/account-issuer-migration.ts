import type { Pool } from "pg";

type MigrationRow = Record<string, unknown>;

export interface AccountIssuerMigrationClient {
  query<Row extends MigrationRow>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  release(): void;
}

export interface AccountIssuerMigrationDatabase {
  connect(): Promise<AccountIssuerMigrationClient>;
}

export type AccountIssuerMigrationResult = "absent" | "current" | "migrated";

const LEGACY_ACCOUNT_ISSUERS = new Map<string, string>([
  ["credential", "local:credential"],
  ["google", "https://accounts.google.com"],
  ["github", "local:oauth:github"],
  ["apple", "https://appleid.apple.com"],
  ["facebook", "https://www.facebook.com"],
  ["discord", "local:oauth:discord"],
  ["gitlab", "local:oauth:gitlab"],
  ["linkedin", "local:oauth:linkedin"],
  ["twitch", "local:oauth:twitch"],
  ["spotify", "local:oauth:spotify"],
  ["dropbox", "local:oauth:dropbox"],
  ["kakao", "local:oauth:kakao"],
  ["naver", "local:oauth:naver"],
  ["line", "https://access.line.me"],
  ["slack", "local:oauth:slack"],
  ["notion", "local:oauth:notion"],
  ["twitter", "local:oauth:twitter"],
  ["tiktok", "local:oauth:tiktok"],
  ["reddit", "local:oauth:reddit"],
  ["zoom", "local:oauth:zoom"],
  ["figma", "local:oauth:figma"],
  ["salesforce", "local:oauth:salesforce"],
  ["atlassian", "local:oauth:atlassian"],
  ["kick", "local:oauth:kick"],
]);

/**
 * Resolve only identities Better Auth can migrate without consulting mutable or
 * unverified profile data. Microsoft is deliberately absent: its 1.7 identity
 * changes from `sub` to the directory `oid`, which needs a trusted external map.
 */
export function legacyAccountIssuer(providerId: string): string | undefined {
  return LEGACY_ACCOUNT_ISSUERS.get(providerId);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Keep the release that is still serving able to insert accounts during rollout. */
export function legacyAccountIssuerTriggerSql(): string {
  const cases = [...LEGACY_ACCOUNT_ISSUERS.entries()]
    .map(([providerId, issuer]) => `    WHEN ${sqlLiteral(providerId)} THEN ${sqlLiteral(issuer)}`)
    .join("\n");

  return `
CREATE OR REPLACE FUNCTION public.podokit_fill_legacy_account_issuer()
RETURNS trigger
LANGUAGE plpgsql
AS $podokit$
BEGIN
  IF NEW."issuer" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  NEW."issuer" := CASE NEW."providerId"
${cases}
    ELSE NULL
  END;

  IF NEW."issuer" IS NULL THEN
    RAISE EXCEPTION 'Cannot infer Better Auth issuer for legacy provider %', NEW."providerId"
      USING ERRCODE = '23502',
            HINT = 'Add an explicit trusted issuer mapping before creating this account.';
  END IF;

  IF NEW."providerId" = 'credential' THEN
    NEW."accountId" := NEW."userId";
  END IF;

  RETURN NEW;
END
$podokit$;

DROP TRIGGER IF EXISTS podokit_fill_legacy_account_issuer ON "account";
CREATE TRIGGER podokit_fill_legacy_account_issuer
BEFORE INSERT ON "account"
FOR EACH ROW
WHEN (NEW."issuer" IS NULL)
EXECUTE FUNCTION public.podokit_fill_legacy_account_issuer();
`;
}

function readCount(rows: readonly MigrationRow[], label: string): number {
  const value = rows[0]?.count;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`Cannot read ${label} count during the Better Auth account migration.`);
}

export function postgresAccountIssuerMigrationDatabase(pool: Pool): AccountIssuerMigrationDatabase {
  return {
    connect: async (): Promise<AccountIssuerMigrationClient> => {
      const client = await pool.connect();
      return {
        query: async <Row extends MigrationRow>(sql: string, values?: readonly unknown[]): Promise<readonly Row[]> => {
          const result = await client.query<Row>(sql, values === undefined ? undefined : [...values]);
          return result.rows;
        },
        release: (): void => client.release(),
      };
    },
  };
}

/**
 * Upgrade a populated pre-1.7 Better Auth account table without guessing identity.
 *
 * The compatibility trigger is installed in the same transaction as the NOT NULL
 * constraint. Writes from the release that is still serving either receive the
 * exact 1.7 issuer or fail closed for an identity that requires a trusted manual
 * mapping; they can never create a corrupt empty issuer during the rollout.
 */
export async function migrateLegacyAccountIssuers(
  database: AccountIssuerMigrationDatabase,
): Promise<AccountIssuerMigrationResult> {
  const client = await database.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(1886350955, 1)");

    const tableRows = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'account'
      ) AS "exists"
    `);
    if (tableRows[0]?.exists !== true) {
      await client.query("COMMIT");
      transactionOpen = false;
      return "absent";
    }

    const columnRows = await client.query<{ dataType: string; isNullable: "YES" | "NO" }>(`
      SELECT data_type AS "dataType", is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'
    `);
    const column = columnRows[0];
    if (column && column.dataType !== "text" && column.dataType !== "character varying") {
      throw new Error(`Cannot migrate Better Auth account issuer from database type ${column.dataType}.`);
    }

    if (column?.isNullable === "NO") {
      const invalidRows = await client.query<MigrationRow>(`
        SELECT COUNT(*)::int AS "count"
        FROM "account"
        WHERE btrim("issuer") = ''
      `);
      if (readCount(invalidRows, "blank issuer") > 0) {
        throw new Error("Cannot continue: the Better Auth account table contains blank issuer values.");
      }
      await client.query(legacyAccountIssuerTriggerSql());
      await client.query("COMMIT");
      transactionOpen = false;
      return "current";
    }

    if (!column) {
      await client.query('ALTER TABLE "account" ADD COLUMN "issuer" text');
    }

    const providerRows = await client.query<{ providerId: string }>(`
      SELECT DISTINCT "providerId"
      FROM "account"
      WHERE "issuer" IS NULL
      ORDER BY "providerId"
    `);
    for (const { providerId } of providerRows) {
      const issuer = legacyAccountIssuer(providerId);
      if (!issuer) {
        throw new Error(
          `Cannot infer a trusted Better Auth issuer for legacy provider ${providerId}. ` +
            "Follow the Better Auth 1.7 account identity migration guide and provide a verified mapping.",
        );
      }

      if (providerId === "credential") {
        const mismatchRows = await client.query<MigrationRow>(`
          SELECT COUNT(*)::int AS "count"
          FROM "account"
          WHERE "issuer" IS NULL
            AND "providerId" = 'credential'
            AND "accountId" <> "userId"
        `);
        if (readCount(mismatchRows, "credential identity mismatch") > 0) {
          throw new Error(
            "Cannot migrate credential accounts whose accountId differs from the linked userId.",
          );
        }
      }

      await client.query(
        `UPDATE "account"
         SET "issuer" = $1,
             "accountId" = CASE WHEN "providerId" = 'credential' THEN "userId" ELSE "accountId" END
         WHERE "issuer" IS NULL AND "providerId" = $2`,
        [issuer, providerId],
      );
    }

    const invalidRows = await client.query<MigrationRow>(`
      SELECT COUNT(*)::int AS "count"
      FROM "account"
      WHERE "issuer" IS NULL OR btrim("issuer") = ''
    `);
    if (readCount(invalidRows, "unresolved issuer") > 0) {
      throw new Error("Cannot continue: one or more Better Auth accounts have no trusted issuer.");
    }

    const collisionRows = await client.query<MigrationRow>(`
      SELECT COUNT(*)::int AS "count"
      FROM (
        SELECT "issuer", "accountId"
        FROM "account"
        GROUP BY "issuer", "accountId"
        HAVING COUNT(*) > 1
      ) AS collisions
    `);
    if (readCount(collisionRows, "identity collision") > 0) {
      throw new Error(
        "Cannot continue: Better Auth accounts collide on the new issuer and accountId identity key.",
      );
    }

    await client.query(legacyAccountIssuerTriggerSql());
    await client.query('ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL');
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")',
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return "migrated";
  } catch (error: unknown) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
