import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLAG_DEFAULTS, mergeFlagDefaults } from "./flag-defaults";

describe("feature flag defaults", () => {
  test("adds the application's flags after PodoKit's", () => {
    const merged = mergeFlagDefaults(FLAG_DEFAULTS, { reportsEnabled: true, betaSearch: false });
    expect(merged).toMatchObject({ twoFactor: true, phoneNumber: false, reportsEnabled: true, betaSearch: false });
  });

  test("rejects an application flag that reuses a PodoKit name", () => {
    expect(() => mergeFlagDefaults(FLAG_DEFAULTS, { passkey: false })).toThrow(
      "app-flags.ts redefines PodoKit feature flags: passkey",
    );
  });

  test("reads stored application flags and keeps their defaults otherwise", async () => {
    // A copy next to an app-flags.ts of the test's own, in the API directory.
    const root = mkdtempSync(join(__dirname, ".app-flags-"));
    try {
      copyFileSync(join(__dirname, "flag-defaults.ts"), join(root, "flag-defaults.ts"));
      writeFileSync(
        join(root, "app-flags.ts"),
        "export const APP_FLAG_DEFAULTS = { reportsEnabled: true, betaSearch: false };\n",
      );
      writeFileSync(join(root, "check.ts"), [
        'import { APP_FLAGS, FEATURE_FLAGS, flagsFrom } from "./flag-defaults";',
        'const flags = flagsFrom(new Map([["betaSearch", "true"], ["magicLink", "false"]]));',
        "console.log(JSON.stringify([APP_FLAGS, FEATURE_FLAGS.includes(\"reportsEnabled\"), flags.reportsEnabled, flags.betaSearch, flags.magicLink]));",
        "",
      ].join("\n"));
      const child = Bun.spawn([process.execPath, join(root, "check.ts")], { stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect({ code, stdout: stdout.trim() }).toEqual({
        code: 0,
        stdout: '[["reportsEnabled","betaSearch"],true,true,true,false]',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
