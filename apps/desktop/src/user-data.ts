import { isAbsolute, resolve } from "node:path";

/** Honor Electron's standard switch before acquiring the single-instance lock. */
export function userDataDirectory(args: readonly string[]): string | undefined {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--user-data-dir") paths.push(args[++index] ?? "");
    else if (arg?.startsWith("--user-data-dir=")) paths.push(arg.slice("--user-data-dir=".length));
  }
  if (paths.length === 0) return undefined;
  if (paths.length !== 1 || !paths[0] || !isAbsolute(paths[0])) {
    throw new Error("Pass exactly one absolute --user-data-dir path");
  }
  return resolve(paths[0]);
}
