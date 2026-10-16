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

interface LaunchOptions {
  /** Starts the launcher from the directory above the API, like a repository root. */
  fromParent?: boolean;
  files?: Record<string, string>;
}

/** Runs the migrate:all launcher in an API layout whose entries print their own path. */
async function launch(entries: string[], nodeEnv: string, body = "", options: LaunchOptions = {}): Promise<Launch> {
  const parent = mkdtempSync(join(tmpdir(), "run-migrations-"));
  const root = join(parent, "api");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    cpSync(LAUNCHER, join(root, "scripts/run-migrations.mjs"));
    for (const entry of entries) {
      mkdirSync(dirname(join(root, entry)), { recursive: true });
      writeFileSync(join(root, entry), `console.log(${JSON.stringify(entry)});\n${body}`);
    }
    for (const [path, content] of Object.entries(options.files ?? {})) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const child = Bun.spawn([process.execPath, options.fromParent ? "api/scripts/run-migrations.mjs" : "scripts/run-migrations.mjs"], {
      cwd: options.fromParent ? parent : root,
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
    rmSync(parent, { recursive: true, force: true });
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

  it("runs the migration in the API directory when started from elsewhere", async () => {
    const apiRoot = 'realpathSync(join(import.meta.dir, "../.."))';
    const result = await launch(
      ["src/database/migrate.ts"],
      "development",
      `import { realpathSync } from "node:fs";\nimport { join } from "node:path";\n` +
        `console.log(realpathSync(process.cwd()) === ${apiRoot});\n`,
      { fromParent: true },
    );
    expect(result).toMatchObject({ code: 0, stdout: "src/database/migrate.ts\ntrue" });
  });

  it("applies the API's decorator settings when started from elsewhere", async () => {
    // TypeORM entities need legacy decorators, which Bun takes from the
    // tsconfig.json of the working directory rather than of the source file.
    const result = await launch(
      ["src/database/migrate.ts"],
      "development",
      'await import("../entity.ts");\n',
      {
        fromParent: true,
        files: {
          "tsconfig.json": JSON.stringify({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }),
          "src/entity.ts": [
            "const Column = (): PropertyDecorator => (target) => console.log(typeof target);",
            "export class Item {",
            "  @Column()",
            "  name!: string;",
            "}",
            "",
          ].join("\n"),
        },
      },
    );
    expect(result).toMatchObject({ code: 0, stdout: "src/database/migrate.ts\nobject" });
  });

  it("fails when no migration entry exists", async () => {
    const result = await launch([], "development");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no migration entry in src or dist");
  });
});
