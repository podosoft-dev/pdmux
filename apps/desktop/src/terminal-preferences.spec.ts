import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TERMINAL_PREFERENCES, type TerminalPreferences } from "@pdmux/core";
import { TerminalPreferencesFile } from "./terminal-preferences.js";

describe("[TC-PDDESKTOP-023] stable local terminal preferences", () => {
  it("persists across launches and preserves the last valid file on rejected input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdmux-preferences-"));
    try {
      const path = join(root, "profile", "terminal-preferences.json");
      const file = new TerminalPreferencesFile(path);
      expect(await file.read()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
      const wanted: TerminalPreferences = { ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: "Menlo", fontSize: 18, theme: "dracula" };
      await file.save(wanted);
      expect(await new TerminalPreferencesFile(path).read()).toEqual(wanted);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(file.save({ ...wanted, fontSize: 100 })).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(wanted);
      expect(await readdir(join(root, "profile"))).toEqual(["terminal-preferences.json"]);
      await writeFile(path, "invalid json");
      await expect(file.read()).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("invalid json");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
