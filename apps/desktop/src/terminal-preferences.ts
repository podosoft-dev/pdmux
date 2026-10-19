import { readFile, rename, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_TERMINAL_PREFERENCES, parseTerminalPreferences, type TerminalPreferences } from "@pdmux/core";

export class TerminalPreferencesFile {
  constructor(private readonly path: string) {}

  async read(): Promise<TerminalPreferences> {
    try { return parseTerminalPreferences(JSON.parse(await readFile(this.path, "utf8")) as unknown); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...DEFAULT_TERMINAL_PREFERENCES };
      throw error;
    }
  }

  async save(value: unknown): Promise<TerminalPreferences> {
    const preferences = parseTerminalPreferences(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
    return preferences;
  }
}
