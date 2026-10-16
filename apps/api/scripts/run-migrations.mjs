import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Production images ship only the compiled output.
function entry(name) {
  const compiled = new URL(`../dist/${name}.js`, import.meta.url);
  if (process.env.NODE_ENV === "production" && existsSync(compiled)) return compiled;
  const source = new URL(`../src/${name}.ts`, import.meta.url);
  return existsSync(source) ? source : null;
}

/** Keep Bun's TypeScript loader anchored to the API tsconfig for legacy decorators. */
export function migrationWorkingDirectory(scriptUrl = import.meta.url) {
  return fileURLToPath(new URL("..", scriptUrl));
}

if (import.meta.main) {
  // The auth module adds src/migrate.ts, which applies the Better Auth schema
  // before it runs the application migrations.
  const target = entry("migrate") ?? entry("database/migrate");
  if (!target) {
    process.stderr.write("Run database migrations failed: no migration entry in src or dist\n");
    process.exit(1);
  }
  const subprocess = Bun.spawn([process.execPath, fileURLToPath(target)], {
    cwd: migrationWorkingDirectory(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.exitCode = await subprocess.exited;
}
