import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const compiledEntry = new URL("../dist/migrate.js", import.meta.url);
const sourceEntry = new URL("../src/migrate.ts", import.meta.url);
const useCompiled = process.env.NODE_ENV === "production" && existsSync(compiledEntry);
const entry = useCompiled ? compiledEntry : sourceEntry;
const subprocess = Bun.spawn([process.execPath, fileURLToPath(entry)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await subprocess.exited;
