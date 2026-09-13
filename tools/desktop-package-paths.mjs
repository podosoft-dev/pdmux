import assert from "node:assert/strict";
import { join } from "node:path";

export function desktopPaths(directory, platform) {
  assert.ok(["darwin", "win32", "linux"].includes(platform), "Unsupported desktop platform");
  const resources = join(directory, platform === "darwin" ? "Contents/Resources" : "resources");
  return {
    executable: join(directory, platform === "darwin" ? "Contents/MacOS/pdmux" : platform === "win32" ? "pdmux.exe" : "pdmux"),
    resources,
    bun: join(resources, "bin", platform === "win32" ? "bun.exe" : "bun"),
  };
}
