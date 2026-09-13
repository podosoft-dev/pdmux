import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { desktopPaths } from "./desktop-package-paths.mjs";

describe("[TC-PDDESKTOP-009] native package executable resolution", () => {
  it("selects executable and runtime from each actual package layout", () => {
    const root = join("temporary directory", "pdmux");
    for (const [platform, executable, resources, bun] of [
      ["darwin", "Contents/MacOS/pdmux", "Contents/Resources", "bun"],
      ["win32", "pdmux.exe", "resources", "bun.exe"],
      ["linux", "pdmux", "resources", "bun"],
    ]) {
      expect(desktopPaths(root, platform)).toEqual({
        executable: join(root, executable), resources: join(root, resources),
        bun: join(root, resources, "bin", bun),
      });
    }
    expect(() => desktopPaths(root, "freebsd")).toThrow("Unsupported desktop platform");
  });
});
