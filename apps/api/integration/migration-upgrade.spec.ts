import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSource } from "typeorm";
import { createAppDataSource, createDataSourceOptions } from "../src/database/data-source";
import { POSTGRES_MIGRATIONS } from "../src/database/migrations";
import { assertMigrationsApplied, initializeApplicationDataSource } from "../src/database/schema-readiness";
import { Host } from "../src/hosts/host.entity";
import { FileTransfer, FileTransferEntry } from "../src/file-transfers/file-transfer.entity";

if (process.env.PDMUX_MIGRATION_TEST_ISOLATED !== "1" || process.env.POSTGRES_HOST !== "127.0.0.1") {
  throw new Error("Run this destructive fixture only through bun run test:migrations");
}

describe("[TC-PDHOST-030][TC-PDHOST-026] published migration upgrade path", () => {
  it("preserves an installed schema, relaxes the account issuer, rolls back failures, and tolerates old clients and reruns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdmux-upgrade-bundle-"));
    const bundle = join(directory, "migrate.js");
    copyFileSync(join(__dirname, "../dist/migrate.js"), bundle);
    const options = createDataSourceOptions(process.env);
    const source = new DataSource({ ...options, entities: [] });
    const runtime = createAppDataSource(options);
    async function migrate(): Promise<{ code: number; stderr: string }> {
      const image = process.env.PDMUX_MIGRATION_TEST_IMAGE;
      const container = process.env.PDMUX_MIGRATION_TEST_CONTAINER;
      if (image && !container?.startsWith("pdmux-migration-test-")) throw new Error("Invalid isolated database container");
      const command = image ? [
        "docker", "--context", "default", "run", "--rm", "--network", `container:${container}`,
        "--env", "POSTGRES_HOST=127.0.0.1", "--env", "POSTGRES_PORT=5432",
        ...["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "CORS_ORIGIN"]
          .flatMap((key) => ["--env", key]),
        "--entrypoint", "bun", image, "dist/migrate.js",
      ] : [process.execPath, bundle];
      const child = Bun.spawn(command, {
        cwd: directory, env: process.env, stdout: "pipe", stderr: "pipe",
      });
      const [, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, stderr };
    }
    async function count(sql: string): Promise<number> {
      const rows: Array<{ count: string }> = await source.query(sql);
      return Number(rows[0]?.count);
    }
    // The account identity shape Better Auth 1.7.0-1.7.2 created, with the
    // compatibility trigger releases 0.11.1 to 0.13.x installed for a serving
    // older API. Production databases carry exactly this until the next migration.
    async function recreateLegacyAccountIdentity(): Promise<void> {
      await source.query('DROP INDEX IF EXISTS "account_providerId_accountId_uidx"');
      await source.query('ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL');
      await source.query('CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")');
      await source.query(`CREATE OR REPLACE FUNCTION public.podokit_fill_legacy_account_issuer()
        RETURNS trigger LANGUAGE plpgsql AS $fixture$
        BEGIN
          NEW."issuer" := CASE NEW."providerId" WHEN 'credential' THEN 'local:credential' ELSE NULL END;
          IF NEW."issuer" IS NULL THEN
            RAISE EXCEPTION 'Cannot infer Better Auth issuer for legacy provider %', NEW."providerId"
              USING ERRCODE = '23502';
          END IF;
          IF NEW."providerId" = 'credential' THEN NEW."accountId" := NEW."userId"; END IF;
          RETURN NEW;
        END
        $fixture$`);
      await source.query(`CREATE TRIGGER podokit_fill_legacy_account_issuer BEFORE INSERT ON "account"
        FOR EACH ROW WHEN (NEW."issuer" IS NULL) EXECUTE FUNCTION public.podokit_fill_legacy_account_issuer()`);
    }
    async function accountIdentity(): Promise<{ trigger: number; issuerNullable: number; issuerIndex: number; providerIndex: number }> {
      return {
        trigger: await count("SELECT count(*) FROM pg_trigger WHERE tgname = 'podokit_fill_legacy_account_issuer'"),
        issuerNullable: await count(`SELECT count(*) FROM information_schema.columns
          WHERE table_name = 'account' AND column_name = 'issuer' AND is_nullable = 'YES'`),
        issuerIndex: await count("SELECT count(*) FROM pg_indexes WHERE indexname = 'account_issuer_accountId_uidx'"),
        providerIndex: await count("SELECT count(*) FROM pg_indexes WHERE indexname = 'account_providerId_accountId_uidx'"),
      };
    }
    const legacyIdentity = { trigger: 1, issuerNullable: 0, issuerIndex: 1, providerIndex: 0 };
    const relaxedIdentity = { trigger: 0, issuerNullable: 1, issuerIndex: 0, providerIndex: 1 };
    async function snapshot(): Promise<unknown> {
      return source.query(`SELECT jsonb_build_object(
        'hosts', (SELECT jsonb_agg(to_jsonb(h) - 'connectorCapabilities' ORDER BY h.id) FROM hosts h),
        'services', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM host_services s),
        'tokens', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM agent_tokens t),
        'layouts', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM user_layouts l),
        'settings', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.key) FROM app_setting a),
        'accounts', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM account a),
        'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM "user" u)
      ) AS data`);
    }
    try {
      // First install must work with the same bundle and without a source/migrations directory.
      expect(await migrate()).toEqual({ code: 0, stderr: "" });
      await source.initialize();
      expect(await count("SELECT count(*) FROM migrations")).toBe(POSTGRES_MIGRATIONS.length);
      expect(await source.showMigrations()).toBe(false);

      // Recreate the application schema shipped by 0.11.5, retaining its migration ledger.
      while (await count("SELECT count(*) FROM migrations") > 19) {
        await source.undoLastMigration({ transaction: "all" });
      }
      expect(await count("SELECT count(*) FROM migrations")).toBe(19);
      await expect(initializeApplicationDataSource(runtime)).rejects.toThrow("pending migrations");
      expect(runtime.isInitialized).toBe(false);
      await recreateLegacyAccountIdentity();
      expect(await accountIdentity()).toEqual(legacyIdentity);

      await source.query(`INSERT INTO hosts (id, "organizationId", label, "agentVersion", "lastHeartbeat")
        VALUES ('00000000-0000-4000-8000-000000000001', 'podokit', 'podokit', '0.1.23', '{"cpuPct":12}')`);
      await source.query(`INSERT INTO host_services ("hostId", label, port) VALUES
        ('00000000-0000-4000-8000-000000000001', 'podokit', 5002)`);
      await source.query(`INSERT INTO agent_tokens ("hostId", name, "tokenHash") VALUES
        ('00000000-0000-4000-8000-000000000001', 'podokit', repeat('1', 64))`);
      await source.query(`INSERT INTO user_layouts ("userId", name, "isDefault", payload)
        VALUES ('podokit', 'podokit', true, '{"columns":2}')`);
      await source.query(`UPDATE app_setting SET value = 'false' WHERE key = 'magicLink'`);
      await source.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        VALUES ('podokit', 'podokit', 'podokit@example.com', true, now(), now())`);
      await source.query(`INSERT INTO account (id, "userId", "accountId", "providerId", issuer, password, "createdAt", "updatedAt")
        VALUES ('podokit', 'podokit', 'podokit', 'credential', 'local:credential', 'preserved-fixture-hash', now(), now())`);

      // Two accounts with one (providerId, accountId) cannot both keep their identity
      // once the issuer is gone, so the migration must stop before changing anything.
      await source.query(`INSERT INTO account (id, "userId", "accountId", "providerId", issuer, "createdAt", "updatedAt")
        VALUES ('podokit-duplicate', 'podokit', 'podokit', 'credential', 'legacy:duplicate', now(), now())`);
      const duplicate = await migrate();
      expect(duplicate.code).not.toBe(0);
      expect(duplicate.stderr).toContain("duplicate providerId and accountId");
      expect(await accountIdentity()).toEqual(legacyIdentity);
      expect(await count("SELECT count(*) FROM migrations")).toBe(19);
      await source.query(`DELETE FROM account WHERE id = 'podokit-duplicate'`);
      const before = await snapshot();

      // Fail after the first ALTER TABLE to prove transaction rollback, not just a nonzero exit.
      await source.query("CREATE TABLE integration_connections (id text)");
      const failed = await migrate();
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain("already exists");
      expect(await count(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'hosts'
        AND column_name = 'connectorCapabilities'`)).toBe(0);
      expect(await count("SELECT count(*) FROM migrations")).toBe(19);
      expect(await snapshot()).toEqual(before);
      await source.query("DROP TABLE integration_connections");

      expect(await migrate()).toEqual({ code: 0, stderr: "" });
      expect(await snapshot()).toEqual(before);
      expect(await accountIdentity()).toEqual(relaxedIdentity);
      expect(await count("SELECT count(*) FROM migrations")).toBe(POSTGRES_MIGRATIONS.length);
      await initializeApplicationDataSource(runtime);
      await assertMigrationsApplied(runtime);
      const host = await runtime.getRepository(Host).findOneByOrFail({ id: "00000000-0000-4000-8000-000000000001" });
      expect(host.connectorCapabilities).toEqual({ cloudflared: false });
      expect(host.agentVersion).toBe("0.1.23");
      // Transfer counters must retain values beyond PostgreSQL's 32-bit integer range.
      const transfer = await runtime.getRepository(FileTransfer).save({
        id: "00000000-0000-4000-8000-000000000002", userId: "podokit", organizationId: "podokit",
        hostId: host.id, direction: "upload", basePath: "", selection: [], state: "paused",
        bytes: 4 * 1024 ** 3, totalBytes: 5 * 1024 ** 3, totalEntries: 1,
        exclusions: [], updated: Date.now(), created: Date.now(),
      });
      await runtime.getRepository(FileTransferEntry).save({
        id: "00000000-0000-4000-8000-000000000003", transferId: transfer.id, path: "file",
        kind: "file", size: 5 * 1024 ** 3, offset: 4 * 1024 ** 3,
      });

      // An old API can still INSERT without the new column and update its existing fields.
      await source.query(`INSERT INTO hosts ("organizationId", label) VALUES ('podokit', 'localhost')`);
      await source.query(`UPDATE hosts SET "lastSeenAt" = now() WHERE label = 'localhost'`);
      const oldWriter = await runtime.getRepository(Host).findOneByOrFail({ label: "localhost" });
      expect(oldWriter.connectorCapabilities).toEqual({ cloudflared: false });
      expect(oldWriter.lastSeenAt).toBeInstanceOf(Date);
      // The serving 0.13.x API still writes an issuer; the current one writes none.
      await source.query(`INSERT INTO account (id, "userId", "accountId", "providerId", issuer, "createdAt", "updatedAt")
        VALUES ('podokit-old-client', 'podokit', '41', 'github', 'local:oauth:github', now(), now())`);
      await source.query(`INSERT INTO account (id, "userId", "accountId", "providerId", "createdAt", "updatedAt")
        VALUES ('podokit-new-client', 'podokit', '42', 'github', now(), now())`);
      await expect(source.query(`INSERT INTO account (id, "userId", "accountId", "providerId", "createdAt", "updatedAt")
        VALUES ('podokit-collision', 'podokit', '42', 'github', now(), now())`)).rejects.toThrow("account_providerId_accountId_uidx");
      const after = await snapshot();
      expect(await migrate()).toEqual({ code: 0, stderr: "" });
      expect(await snapshot()).toEqual(after);
      expect(await accountIdentity()).toEqual(relaxedIdentity);
      expect(await source.showMigrations()).toBe(false);
      expect((await runtime.getRepository(FileTransfer).findOneByOrFail({ id: transfer.id })).bytes).toBe(4 * 1024 ** 3);
      expect((await runtime.getRepository(FileTransferEntry).findOneByOrFail({ transferId: transfer.id })).offset).toBe(4 * 1024 ** 3);
    } finally {
      if (runtime.isInitialized) await runtime.destroy();
      if (source.isInitialized) await source.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
