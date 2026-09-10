import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

describe("[TC-PDDESKTOP-009] desktop Node module interoperability", () => {
  it("emits a sandbox-compatible preload that exposes only the desktop bridge", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const extension = main.includes('"preload.cjs"') ? "cts" : "ts";
    const source = fileURLToPath(new URL(`./preload.${extension}`, import.meta.url));
    const program = ts.createProgram([source], {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, skipLibCheck: true,
    });
    let output = "";
    program.emit(undefined, (file, text) => { if (/preload\.(cjs|js)$/.test(file)) output = text; });
    expect(output.length).toBeGreaterThan(0);
    const exposed: Record<string, unknown> = {};
    new Script(output).runInNewContext({
      exports: {}, process: { platform: "darwin" },
      require: (name: string): unknown => {
        expect(name).toBe("electron");
        return { contextBridge: { exposeInMainWorld: (key: string, value: unknown): void => { exposed[key] = value; } } };
      },
    });
    expect(exposed.pdmuxDesktop).toMatchObject({ isDesktop: true, platform: "darwin" });
    const bridge = exposed.pdmuxDesktop as { transfers: Record<string, unknown> };
    expect(Object.keys(bridge.transfers).sort()).toEqual(["cancelDownload", "download", "pauseDownload", "pickFolder", "read", "release", "status"]);
    expect(Object.values(bridge.transfers).every((value) => typeof value === "function")).toBe(true);
    expect(main).toContain("sandbox: true");
    expect(main).toContain("contextIsolation: true");
  });
  it("loads the actual updater import through Node ESM, not Bun's permissive loader", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const declaration = main.match(/^import .+ from "electron-updater";$/m)?.[0];
    expect(declaration).toBeDefined();
    const result = spawnSync("node", ["--input-type=module", "-e", `${declaration}\nconsole.log("imported");`], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imported");
  });
});
