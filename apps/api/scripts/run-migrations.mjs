import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const compiledEntry = new URL("../dist/migrate.js", import.meta.url);
const sourceEntry = new URL("../src/migrate.ts", import.meta.url);
const useCompiled = process.env.NODE_ENV === "production" && existsSync(compiledEntry);
const entry = useCompiled ? compiledEntry : sourceEntry;

/** Keep Bun's TypeScript loader anchored to the API tsconfig for legacy decorators. */
export function migrationWorkingDirectory(scriptUrl = import.meta.url) {
  return fileURLToPath(new URL("..", scriptUrl));
}

if (import.meta.main) {
  const subprocess = Bun.spawn([process.execPath, fileURLToPath(entry)], {
    cwd: migrationWorkingDirectory(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.exitCode = await subprocess.exited;
}
