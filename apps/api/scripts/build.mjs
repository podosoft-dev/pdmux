import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appBuildTargets } from "./build.extensions.mjs";

// Bun inlines process.env.NODE_ENV as "development" unless told otherwise, which
// would make every production check in the bundle, its dependencies included,
// take the development branch. Keep it a read of the runtime environment.
const define = { "process.env.NODE_ENV": "process.env.NODE_ENV" };

const targets = [
  { entrypoint: "src/main.ts", outdir: "dist" },
  { entrypoint: "src/database/migrate.ts", outdir: "dist/database" },
  { entrypoint: "src/migrate.ts", outdir: "dist" },
  { entrypoint: "src/main-worker.ts", outdir: "dist" },
  { entrypoint: "src/bootstrap-admin-runtime.ts", outdir: "dist" },
].filter((target) => existsSync(target.entrypoint));

for (const target of appBuildTargets) {
  if (!existsSync(target.entrypoint)) {
    process.stderr.write(`Build failed: ${target.entrypoint} from build.extensions.mjs does not exist\n`);
    process.exit(1);
  }
  targets.push(target);
}

for (const target of targets) {
  const result = await Bun.build({
    entrypoints: [target.entrypoint],
    outdir: target.outdir,
    target: "bun",
    define,
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.exit(1);
  }
}

function fail(message) {
  process.stderr.write(`Build migrations failed: ${message}\n`);
  process.exit(1);
}

function isMigration(value) {
  return typeof value === "function" &&
    typeof value.prototype?.up === "function" &&
    typeof value.prototype?.down === "function";
}

// Every source migration becomes dist/migrations/<file>.js, listed with its name
// in dist/migrations/migrations.json, which the migrators and the API read in
// production. A build that emits them anywhere else, or loses one, fails here
// instead of a deployment that runs no migrations.
const sources = existsSync("src/migrations")
  ? readdirSync("src/migrations").filter((file) => /^\d+-.+\.ts$/.test(file)).sort()
  : [];
rmSync("dist/migrations", { recursive: true, force: true });
mkdirSync("dist/migrations", { recursive: true });
if (sources.length > 0) {
  const result = await Bun.build({
    entrypoints: sources.map((file) => `src/migrations/${file}`),
    outdir: "dist/migrations",
    root: "src/migrations",
    target: "bun",
    define,
    external: ["typeorm"],
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.exit(1);
  }
}
const files = sources.map((file) => file.replace(/\.ts$/, ".js"));
const built = readdirSync("dist/migrations", { recursive: true }).map(String).sort();
if (JSON.stringify(built) !== JSON.stringify(files)) {
  fail(`expected ${JSON.stringify(files)} in dist/migrations, found ${JSON.stringify(built)}`);
}
const list = [];
for (const file of files) {
  const module = await import(pathToFileURL(resolve("dist/migrations", file)).href);
  const classes = Object.values(module).filter(isMigration);
  if (classes.length !== 1) fail(`${file} must export exactly one migration class`);
  const [Migration] = classes;
  list.push({ file, name: new Migration().name || Migration.name });
}
writeFileSync("dist/migrations/migrations.json", `${JSON.stringify(list, null, 2)}\n`);
process.stdout.write(`Built ${list.length} migrations\n`);
