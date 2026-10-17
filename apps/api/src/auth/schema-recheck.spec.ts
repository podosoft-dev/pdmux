import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createSchemaRecheck, isSchemaMismatch, type SchemaCheckedAuth } from "./schema-recheck";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function options(database: Database): BetterAuthOptions {
  return {
    database,
    secret: "schema-recheck-test-secret-with-32-characters",
    baseURL: "http://localhost:5002",
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  };
}

async function signUp(auth: ReturnType<typeof betterAuth>): Promise<unknown> {
  try {
    await auth.api.signUpEmail({
      body: { email: `${crypto.randomUUID()}@example.com`, password: "password123", name: "A" },
    });
    return "signed up";
  } catch (error) {
    return error;
  }
}

function fakeAuth(check: () => Promise<void> | undefined): SchemaCheckedAuth {
  return { $context: Promise.resolve({ checkSchema: check }) };
}

describe("schema recheck", () => {
  it("lets an API that started before the migrations sign users up once another process ran them", async () => {
    const root = mkdtempSync(join(tmpdir(), "schema-recheck-"));
    roots.push(root);
    const file = join(root, "auth.sqlite");
    const api = new Database(file, { create: true });
    try {
      let auth = betterAuth(options(api));
      expect(isSchemaMismatch(await signUp(auth))).toBe(true);

      // migrate:all runs in a process of its own, with a connection of its own.
      const migrator = new Database(file);
      await (await getMigrations(options(migrator))).runMigrations();
      migrator.close();
      // Better Auth keeps the mismatch it found.
      expect(isSchemaMismatch(await signUp(auth))).toBe(true);

      await createSchemaRecheck()(auth, () => { auth = betterAuth(options(api)); });
      expect(await signUp(auth)).toBe("signed up");
    } finally {
      api.close();
    }
  });

  it("rebuilds at most once per interval while the mismatch lasts", async () => {
    let clock = 0;
    let rebuilds = 0;
    const recheck = createSchemaRecheck({ intervalMs: 2_000, now: () => clock });
    const mismatched = fakeAuth(() => Promise.reject(Object.assign(new Error("mismatch"), { code: "SCHEMA_MISMATCH" })));
    await recheck(mismatched, () => { rebuilds += 1; });
    clock = 1_999;
    await recheck(mismatched, () => { rebuilds += 1; });
    expect(rebuilds).toBe(1);
    clock = 2_000;
    await recheck(mismatched, () => { rebuilds += 1; });
    expect(rebuilds).toBe(2);
  });

  it("leaves a clean schema and an unreachable database alone", async () => {
    let rebuilds = 0;
    const recheck = createSchemaRecheck();
    await recheck(fakeAuth(() => undefined), () => { rebuilds += 1; });
    await recheck(fakeAuth(() => Promise.reject(new Error("connect ECONNREFUSED"))), () => { rebuilds += 1; });
    expect(rebuilds).toBe(0);
  });
});
