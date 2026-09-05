import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const image = process.argv[2];
if (!image || image.startsWith("-") || /\s/.test(image)) {
  throw new Error("Provide exactly one API image reference");
}
const expected = readdirSync(new URL("../apps/api/src/migrations", import.meta.url))
  .filter((file) => /^\d+-.+\.ts$/.test(file))
  .map((file) => {
    const match = /^(\d+)-(.+)\.ts$/.exec(file);
    return `${match[2]}${match[1]}`;
  })
  .sort();
const output = execFileSync("docker", [
  "run", "--rm", "--network", "none", "--entrypoint", "bun", image,
  "dist/database/migrate.js", "--list",
], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
assert.deepEqual(JSON.parse(output).sort(), expected, "Final API image must carry every migration");
assert.ok(expected.length > 0, "A release cannot contain an empty migration registry");
console.log(`Verified ${expected.length} migrations in ${image}`);
