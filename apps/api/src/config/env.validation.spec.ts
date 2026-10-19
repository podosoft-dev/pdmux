import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEnv } from "./env.validation";

describe("environment validation", () => {
  it("listens on every address and keeps SQLite under data/ by default", () => {
    expect(validateEnv({})).toMatchObject({ HOST: "0.0.0.0", SQLITE_PATH: "./data/podokit.sqlite" });
  });

  it("reads SHUTDOWN_TIMEOUT in whole seconds, 30 when unset or empty", () => {
    expect(validateEnv({}).SHUTDOWN_TIMEOUT).toBe(30);
    expect(validateEnv({ SHUTDOWN_TIMEOUT: "" }).SHUTDOWN_TIMEOUT).toBe(30);
    expect(validateEnv({ SHUTDOWN_TIMEOUT: "0" }).SHUTDOWN_TIMEOUT).toBe(0);
    expect(validateEnv({ SHUTDOWN_TIMEOUT: "45" }).SHUTDOWN_TIMEOUT).toBe(45);
    for (const value of ["-1", "1.5", "soon", "2147484"]) {
      expect(() => validateEnv({ SHUTDOWN_TIMEOUT: value })).toThrow("Invalid environment");
    }
  });

  it("reads HOST and SQLITE_PATH", () => {
    expect(validateEnv({ HOST: " 127.0.0.1 ", SQLITE_PATH: "/var/lib/app/app.sqlite" }))
      .toMatchObject({ HOST: "127.0.0.1", SQLITE_PATH: "/var/lib/app/app.sqlite" });
    expect(() => validateEnv({ HOST: " " })).toThrow("Invalid environment");
  });
});

/** Runs `script` next to a copy of env.validation.ts and an env.extensions.ts of the test's own. */
async function withExtensions(extensions: string, script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // Inside the API directory, so the copies resolve zod like the originals.
  const root = mkdtempSync(join(__dirname, ".env-extensions-"));
  try {
    copyFileSync(join(__dirname, "env.validation.ts"), join(root, "env.validation.ts"));
    writeFileSync(join(root, "env.extensions.ts"), extensions);
    writeFileSync(join(root, "check.ts"), script);
    const child = Bun.spawn([process.execPath, join(root, "check.ts")], { stdout: "pipe", stderr: "pipe" });
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

describe("application environment", () => {
  const extensions = [
    'import { z } from "zod";',
    'import type { AppEnv } from "./env.validation";',
    "export const appEnvShape = {",
    "  REPORTS_BUCKET: z.string().min(1),",
    "  SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),",
    "};",
    "export function refineAppEnv(env: AppEnv, context: z.RefinementCtx): void {",
    '  if (env.NODE_ENV === "production" && env.REPORTS_BUCKET === "dev") {',
    '    context.addIssue({ code: "custom", path: ["REPORTS_BUCKET"], message: "use a production bucket" });',
    "  }",
    "}",
    "",
  ].join("\n");

  it("validates and types the variables of env.extensions.ts with PodoKit's", async () => {
    const result = await withExtensions(extensions, [
      'import { validateEnv } from "./env.validation";',
      'const env = validateEnv({ REPORTS_BUCKET: "reports" });',
      "const interval: number = env.SYNC_INTERVAL_SECONDS;",
      "console.log(JSON.stringify([env.REPORTS_BUCKET, interval, env.PORT]));",
      "for (const input of [{}, { NODE_ENV: \"production\", REPORTS_BUCKET: \"dev\" }]) {",
      "  try { validateEnv(input); } catch (error) { console.log((error as Error).message.includes(\"REPORTS_BUCKET\")); }",
      "}",
      "",
    ].join("\n"));
    expect(result).toMatchObject({ code: 0, stdout: '["reports",60,5002]\ntrue\ntrue' });
  });

  it("rejects a variable PodoKit already defines", async () => {
    const result = await withExtensions(
      'import { z } from "zod";\nexport const appEnvShape = { PORT: z.string() };\nexport function refineAppEnv(): void {}\n',
      'import "./env.validation";\n',
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("env.extensions.ts redefines PORT");
  });
});
