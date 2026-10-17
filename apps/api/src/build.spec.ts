import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BUILD = join(__dirname, "../scripts/build.mjs");
// The application's own build.extensions.mjs names entry points this temporary
// layout does not contain, so each build starts without application targets. A
// test that needs some passes its own scripts/build.extensions.mjs.
const NO_APP_TARGETS = "export const appBuildTargets = [];\n";

/** Builds an API layout made of `files` with the app's build script. */
async function build(files: Record<string, string>): Promise<{ root: string; code: number; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "api-build-"));
  mkdirSync(join(root, "scripts"));
  cpSync(BUILD, join(root, "scripts/build.mjs"));
  writeFileSync(join(root, "scripts/build.extensions.mjs"), NO_APP_TARGETS);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const child = Bun.spawn([process.execPath, "scripts/build.mjs"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { root, code, stderr };
}

async function run(root: string, entry: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([process.execPath, entry], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout.trim();
}

const migration = (name: string, body = ""): string =>
  `${body}export class ${name} { name = "${name}"; async up() {} async down() {} }\n`;

describe("API build", () => {
  it("builds every migration flat into dist/migrations and lists it with its name", async () => {
    const { root, code, stderr } = await build({
      "src/config/table.ts": 'export const TABLE = "example";\n',
      "src/migrations/1700000000002-AddIndex.ts": migration(
        "AddIndex1700000000002",
        'import { TABLE } from "../config/table";\nvoid TABLE;\n',
      ),
      "src/migrations/1700000000001-CreateExample.ts": migration("CreateExample1700000000001"),
      "dist/migrations/1690000000000-Removed.js": migration("Removed1690000000000"),
    });
    try {
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(readdirSync(join(root, "dist/migrations"), { recursive: true }).map(String).sort()).toEqual([
        "1700000000001-CreateExample.js",
        "1700000000002-AddIndex.js",
        "migrations.json",
      ]);
      expect(JSON.parse(readFileSync(join(root, "dist/migrations/migrations.json"), "utf8"))).toEqual([
        { file: "1700000000001-CreateExample.js", name: "CreateExample1700000000001" },
        { file: "1700000000002-AddIndex.js", name: "AddIndex1700000000002" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an empty list for an app without migrations", async () => {
    const { root, code } = await build({ "src/main.ts": "export {};\n" });
    try {
      expect(code).toBe(0);
      expect(readFileSync(join(root, "dist/migrations/migrations.json"), "utf8")).toBe("[]\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a migration file without exactly one migration class", async () => {
    const { root, code, stderr } = await build({
      "src/migrations/1700000000001-Two.ts": `${migration("A1700000000001")}${migration("B1700000000001")}`,
    });
    try {
      expect(code).toBe(1);
      expect(stderr).toContain("1700000000001-Two.js must export exactly one migration class");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves NODE_ENV to the environment the bundle runs in", async () => {
    const { root, code, stderr } = await build({ "src/main.ts": "console.log(process.env.NODE_ENV);\n" });
    try {
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(await run(root, "dist/main.js", { NODE_ENV: "production" })).toBe("production");
      expect(await run(root, "dist/main.js", { NODE_ENV: "test" })).toBe("test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bundles the application's entry points from build.extensions.mjs", async () => {
    const { root, code, stderr } = await build({
      "scripts/build.extensions.mjs":
        'export const appBuildTargets = [{ entrypoint: "scripts/repair.ts", outdir: "dist/scripts" }];\n',
      "scripts/repair.ts": 'console.log("repaired", process.env.NODE_ENV);\n',
    });
    try {
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(await run(root, "dist/scripts/repair.js", { NODE_ENV: "production" })).toBe("repaired production");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on an application entry point that does not exist", async () => {
    const { root, code, stderr } = await build({
      "scripts/build.extensions.mjs": 'export const appBuildTargets = [{ entrypoint: "scripts/gone.ts", outdir: "dist" }];\n',
    });
    try {
      expect(code).toBe(1);
      expect(stderr).toContain("scripts/gone.ts from build.extensions.mjs does not exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
