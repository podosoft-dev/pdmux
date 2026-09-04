import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

interface BuildTarget {
  target: string;
  arch: string[];
}

interface DesktopManifest {
  version: string;
  author: { name: string; email: string };
  homepage: string;
  desktopName: string;
  license: string;
  devDependencies: { electron: string };
  build: {
    executableName: string;
    icon: string;
    compression: string;
    electronLanguages: string[];
    mac: { target: BuildTarget[] };
    win: { target: BuildTarget[] };
    linux: { syncDesktopName: boolean; target: BuildTarget[] };
    extraResources: Array<{ from: string; to: string; filter?: string[] }>;
  };
}

interface RootManifest {
  version: string;
  scripts: { "desktop:package": string };
}

describe("[TC-PDDESKTOP-009] desktop packaging matrix", () => {
  it("packages the embedded stack for every supported operating system", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as DesktopManifest;
    const macArchitectures = new Set(manifest.build.mac.target.flatMap((target) => target.arch));
    expect(manifest.build.executableName).toBe("pdmux");
    expect(manifest.build.icon).toBe("../web/static/favicon.svg");
    expect(manifest.build.compression).toBe("maximum");
    expect(manifest.build.electronLanguages).toEqual(["en", "ko"]);
    expect(manifest.author.email).toContain("@");
    expect(manifest.homepage).toBe("https://github.com/podosoft-dev/pdmux");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.desktopName).toBe("dev.podosoft.pdmux");
    expect(manifest.build.linux.syncDesktopName).toBe(true);
    expect(macArchitectures).toEqual(new Set(["x64", "arm64"]));
    expect(manifest.build.win.target.some((target) => target.arch.includes("x64"))).toBe(true);
    expect(manifest.build.linux.target.some((target) => target.arch.includes("x64"))).toBe(true);
    expect(manifest.build.extraResources.map((resource) => resource.to)).toEqual(
      expect.arrayContaining(["api", "web", "bin", "runtime/sqlite-backup.mjs"]),
    );
    expect(manifest.build.extraResources.find((resource) => resource.to === "web")?.filter).toContain(
      "!**/*.map",
    );
  });

  it("keeps the desktop artifact version aligned with the product version", () => {
    const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as DesktopManifest;
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as RootManifest;
    expect(desktop.version).toBe(root.version);
    expect(desktop.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.scripts["desktop:package"]).toContain("bun run build:agent");
  });

  it("builds each supported target in the desktop CI matrix", () => {
    const workflow = readFileSync(new URL("../../../.github/workflows/desktop.yml", import.meta.url), "utf8");
    expect(workflow).toContain("runner: macos-15-intel\n            command: --mac --x64");
    expect(workflow).toContain("runner: macos-15\n            command: --mac --arm64");
    expect(workflow).not.toContain("command: --mac --x64 --arm64");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("bun run desktop:prepare");
    expect(workflow).toContain("bun run --cwd apps/desktop package");
    expect(workflow).toContain("name: pdmux-${{ matrix.artifact }}");
  });
});
