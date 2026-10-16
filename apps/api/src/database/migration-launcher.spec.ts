import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_ROOT = join(__dirname, "../..");

/** Lays out the real launcher and the real API tsconfig.json under `<parent>/api`. */
function apiLayout(parent: string): string {
  const api = join(parent, "api");
  mkdirSync(join(api, "scripts"), { recursive: true });
  mkdirSync(join(api, "src"), { recursive: true });
  cpSync(join(API_ROOT, "scripts/run-migrations.mjs"), join(api, "scripts/run-migrations.mjs"));
  cpSync(join(API_ROOT, "tsconfig.json"), join(api, "tsconfig.json"));
  // pdmux's TypeORM entities need legacy decorators: the target is the prototype.
  writeFileSync(join(api, "src/entity.ts"), [
    "const Column = (): PropertyDecorator => (target) => console.log(typeof target);",
    "export class Item {",
    "  @Column()",
    "  name!: string;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(api, "src/migrate.ts"), [
    'import { realpathSync } from "node:fs";',
    `console.log(realpathSync(process.cwd()) === ${JSON.stringify(realpathSync(api))});`,
    'await import("./entity.ts");',
    "",
  ].join("\n"));
  return api;
}

describe("[TC-PDHOST-025] migration launcher started from the repository root", () => {
  it("runs the migration in the API directory with the API's decorator settings", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pdmux-migrate-")));
    try {
      apiLayout(parent);
      const child = Bun.spawn([process.execPath, "api/scripts/run-migrations.mjs"], {
        cwd: parent,
        env: { ...process.env, NODE_ENV: "development" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect({ code, stdout: stdout.trim() }, stderr).toEqual({ code: 0, stdout: "true\nobject" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
