import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Production images ship only the compiled output.
function entry(name) {
  const compiled = new URL(`../dist/${name}.js`, import.meta.url);
  if (process.env.NODE_ENV === "production" && existsSync(compiled)) return compiled;
  const source = new URL(`../src/${name}.ts`, import.meta.url);
  return existsSync(source) ? source : null;
}

const args = process.argv.slice(2);
// The auth module adds src/migrate.ts, which applies the Better Auth schema
// before it runs the application migrations. --list needs neither the
// database nor auth, so it uses the application migrator.
const target = args.includes("--list")
  ? entry("database/migrate")
  : entry("migrate") ?? entry("database/migrate");
if (!target) {
  process.stderr.write("Run database migrations failed: no migration entry in src or dist\n");
  process.exit(1);
}
// Run in the API directory wherever this was started from: Bun reads decorator
// settings from the tsconfig.json of the working directory, and the data source
// finds .env and the migrations relative to it.
const subprocess = Bun.spawn([process.execPath, fileURLToPath(target), ...args], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await subprocess.exited;
