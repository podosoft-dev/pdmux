import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageArguments(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--publish" || argument === "-p") {
      if (args[++index] !== "never") throw new Error("Desktop packaging never publishes artifacts");
    } else if (argument.startsWith("--publish=") || argument.startsWith("-p=")) {
      if (argument.split("=")[1] !== "never") throw new Error("Desktop packaging never publishes artifacts");
    } else if (/^-p[^-]/.test(argument) || /^--publish[.]/.test(argument)) {
      throw new Error("Desktop packaging never publishes artifacts");
    } else {
      result.push(argument);
    }
  }
  // Repeated flags become arrays in electron-builder 26's parser, bypassing its
  // string comparison with "never". Emit exactly one policy, from this boundary.
  return [...result, "--publish", "never"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const child = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"), ...packageArguments(process.argv.slice(2))], { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
