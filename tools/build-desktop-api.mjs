import { resolve, join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { desktopApiProfile } from "./desktop-build-profile.mjs";

const root = resolve(import.meta.dirname, "../apps/api");
const outdir = join(root, "dist-desktop");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts"), join(root, "src/desktop-migrate.ts")],
  root: join(root, "src"), outdir, target: "bun", splitting: true,
  minify: { whitespace: true, syntax: true, identifiers: false },
  metafile: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["ioredis", "redis", "pg", "pg-native"],
  plugins: [desktopApiProfile(root)],
});
await Bun.write(join(outdir, "build-profile.json"), JSON.stringify({ inputs: Object.keys(result.metafile.inputs) }));
if (!result.success) throw new AggregateError(result.logs, "Build desktop services failed");
console.log(JSON.stringify({ stage: "desktop-api-build", bytes: result.outputs.reduce((total, file) => total + file.size, 0), chunks: result.outputs.length }));
