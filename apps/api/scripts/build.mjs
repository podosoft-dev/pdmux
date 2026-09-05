import { existsSync } from "node:fs";
import { checkMigrations } from "./check-migrations.mjs";

checkMigrations();

const targets = [
  { entrypoint: "src/main.ts", outdir: "dist" },
  { entrypoint: "src/database/migrate.ts", outdir: "dist/database" },
  { entrypoint: "src/migrate.ts", outdir: "dist" },
  { entrypoint: "src/main-worker.ts", outdir: "dist" },
].filter((target) => existsSync(target.entrypoint));

for (const target of targets) {
  const result = await Bun.build({
    entrypoints: [target.entrypoint],
    outdir: target.outdir,
    target: "bun",
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.exit(1);
  }
}
