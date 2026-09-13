import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { packageArguments } from "./package-desktop.mjs";

describe("[TC-PDDESKTOP-009] local packaging never publishes", () => {
  it("emits one scalar policy even when callers repeat publish never", () => {
    const require = createRequire(import.meta.url);
    const yargs = require("yargs/yargs");
    for (const args of [[], ["--publish", "never", "--linux"], ["--", "--publish", "never", "-p", "never", "--x64"], ["--publish=never", "-p=never"]]) {
      const parsed = yargs(packageArguments(args)).option("publish", { alias: "p" }).parse();
      expect(parsed.publish).toBe("never");
    }
    expect(packageArguments(["--config", "path with spaces.json", "--linux"])).toEqual([
      "--config", "path with spaces.json", "--linux", "--publish", "never",
    ]);
  });
  it("rejects every request to publish before spawning the builder", () => {
    for (const args of [["--publish", "always"], ["-p", "onTag"], ["--publish=onTagOrDraft"], ["--publish"], ["-palways"], ["--publish.always"]]) {
      expect(() => packageArguments(args)).toThrow("never publishes");
    }
  });
});
