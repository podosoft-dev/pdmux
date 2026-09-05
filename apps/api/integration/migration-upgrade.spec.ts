import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSource } from "typeorm";
import { createAppDataSource, createDataSourceOptions } from "../src/database/data-source";
import { POSTGRES_MIGRATIONS } from "../src/database/migrations";
import { assertMigrationsApplied, initializeApplicationDataSource } from "../src/database/schema-readiness";
import { Host } from "../src/hosts/host.entity";

if (process.env.PDMUX_MIGRATION_TEST_ISOLATED !== "1" || process.env.POSTGRES_HOST !== "127.0.0.1") {
  throw new Error("Run this destructive fixture only through bun run test:migrations");
}

describe("[TC-PDHOST-030] published migration upgrade path", () => {
  it("preserves an installed schema, rolls back failures, and tolerates old clients and reruns", async () => {
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
      await source.undoLastMigration({ transaction: "all" });
      expect(await count("SELECT count(*) FROM migrations")).toBe(19);
      await expect(initializeApplicationDataSource(runtime)).rejects.toThrow("pending migrations");
      expect(runtime.isInitialized).toBe(false);

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
      expect(await count("SELECT count(*) FROM migrations")).toBe(POSTGRES_MIGRATIONS.length);
      await initializeApplicationDataSource(runtime);
      await assertMigrationsApplied(runtime);
      const host = await runtime.getRepository(Host).findOneByOrFail({ id: "00000000-0000-4000-8000-000000000001" });
      expect(host.connectorCapabilities).toEqual({ cloudflared: false });
      expect(host.agentVersion).toBe("0.1.23");

      // An old API can still INSERT without the new column and update its existing fields.
      await source.query(`INSERT INTO hosts ("organizationId", label) VALUES ('podokit', 'localhost')`);
      await source.query(`UPDATE hosts SET "lastSeenAt" = now() WHERE label = 'localhost'`);
      const oldWriter = await runtime.getRepository(Host).findOneByOrFail({ label: "localhost" });
      expect(oldWriter.connectorCapabilities).toEqual({ cloudflared: false });
      expect(oldWriter.lastSeenAt).toBeInstanceOf(Date);
      const after = await snapshot();
      expect(await migrate()).toEqual({ code: 0, stderr: "" });
      expect(await snapshot()).toEqual(after);
      expect(await source.showMigrations()).toBe(false);
    } finally {
      if (runtime.isInitialized) await runtime.destroy();
      if (source.isInitialized) await source.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
