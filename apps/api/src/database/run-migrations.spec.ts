import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LAUNCHER = join(__dirname, "../../scripts/run-migrations.mjs");

interface Launch {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the migrate:all launcher in an API layout whose entries print their own path. */
async function launch(entries: string[], nodeEnv: string, body = ""): Promise<Launch> {
  const root = mkdtempSync(join(tmpdir(), "run-migrations-"));
  try {
    mkdirSync(join(root, "scripts"));
    cpSync(LAUNCHER, join(root, "scripts/run-migrations.mjs"));
    for (const entry of entries) {
      mkdirSync(dirname(join(root, entry)), { recursive: true });
      writeFileSync(join(root, entry), `console.log(${JSON.stringify(entry)});\n${body}`);
    }
    const child = Bun.spawn([process.execPath, "scripts/run-migrations.mjs"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: nodeEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("migrate:all launcher", () => {
  it("runs the application migrations from source in development", async () => {
    const result = await launch(["src/database/migrate.ts", "dist/database/migrate.js"], "development");
    expect(result).toMatchObject({ code: 0, stdout: "src/database/migrate.ts" });
  });

  it("runs the compiled application migrations in production", async () => {
    const result = await launch(["src/database/migrate.ts", "dist/database/migrate.js"], "production");
    expect(result).toMatchObject({ code: 0, stdout: "dist/database/migrate.js" });
  });

  it("prefers the auth module's entry, which applies the Better Auth schema first", async () => {
    expect(await launch(["src/migrate.ts", "src/database/migrate.ts"], "development"))
      .toMatchObject({ code: 0, stdout: "src/migrate.ts" });
    // A production image has only the compiled output.
    expect(await launch(["dist/migrate.js", "dist/database/migrate.js"], "production"))
      .toMatchObject({ code: 0, stdout: "dist/migrate.js" });
  });

  it("exits with the migration's status", async () => {
    const result = await launch(["src/database/migrate.ts"], "development", "process.exit(3);\n");
    expect(result.code).toBe(3);
  });

  it("fails when no migration entry exists", async () => {
    const result = await launch([], "development");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no migration entry in src or dist");
  });
});
