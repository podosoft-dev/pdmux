import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every key the source asks for exists, in every locale.
 *
 * ⚠ A MISSING KEY IS SILENT. The catalogues merge English first (`messages.ts`), and `@pdmux/ui`
 * falls back to the English its call site passes, so a key absent from `ko.json` — or from both —
 * renders English inside a Korean screen and nothing fails. Six keys the commit detail and the
 * phone tab bar asked for had never existed in either catalogue; the git dock's facts read
 * "Authored · SHA · Parents" on a Korean dashboard.
 */
const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const CATALOGS = join(WEB, "src/lib/i18n/catalogs");
const SETS = ["admin-dashboard", "app"] as const;
const LOCALES = ["en", "ko"] as const;

type Json = { [key: string]: unknown };

function read(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** Leaf keys as dotted paths. */
function leaves(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

function merge(target: Json, source: Json): Json {
  const result: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = result[key];
    result[key] =
      typeof value === "object" && value !== null && !Array.isArray(value) && typeof current === "object" && current !== null
        ? merge(current as Json, value as Json)
        : value;
  }
  return result;
}

function lookup(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Json)[part];
  }
  return current;
}

/** Like `lookup`, but a path that runs into a string is a method on it (`….count.replace`). */
function pathExists(source: unknown, path: string): boolean {
  let current = source;
  for (const part of path.split(".")) {
    if (typeof current === "string") return true;
    if (typeof current !== "object" || current === null) return false;
    current = (current as Json)[part];
  }
  return current !== undefined;
}

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(svelte|ts)$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

/** Catalogue (one locale, both sets merged) as the app loads it. */
function catalog(locale: (typeof LOCALES)[number]): Json {
  return SETS.reduce<Json>((merged, set) => merge(merged, read(join(CATALOGS, set, `${locale}.json`))), {});
}

/** `t('pdmux.x.y', …)` / `tr("pdmux.x.y", …)` — the `@pdmux/ui` translator's keys. */
const UI_KEY = /\btr?\(\s*['"](pdmux\.[A-Za-z0-9_.-]+)['"]/g;
/** `i18n.t.dash.x.y` — the app's typed catalogue, read as a path. */
const APP_PATH = /\bi18n\.t\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;

function usages(pattern: RegExp, files: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const key = match[1];
      if (key && !found.has(key)) found.set(key, relative(ROOT, file));
    }
  }
  return found;
}

describe("[TC-PDWEB-054] every locale carries the same keys", () => {
  for (const set of SETS) {
    it(`${set}: en and ko have identical key sets`, (): void => {
      const en = new Set(leaves(read(join(CATALOGS, set, "en.json"))));
      const ko = new Set(leaves(read(join(CATALOGS, set, "ko.json"))));
      expect([...en].filter((key) => !ko.has(key)), "missing from ko.json").toEqual([]);
      expect([...ko].filter((key) => !en.has(key)), "missing from en.json").toEqual([]);
    });
  }
});

describe("[TC-PDWEB-055] every key the source asks for exists in every locale", () => {
  const files = [...sources(join(ROOT, "packages/ui/src")), ...sources(join(WEB, "src"))];

  it("finds the usages it checks", (): void => {
    // A scan that matched nothing would pass for the wrong reason.
    expect(usages(UI_KEY, files).size).toBeGreaterThan(100);
    expect(usages(APP_PATH, files).size).toBeGreaterThan(100);
  });

  for (const locale of LOCALES) {
    it(`${locale}: every t('pdmux.…') key is a string`, (): void => {
      const messages = catalog(locale);
      const missing = [...usages(UI_KEY, files)]
        .filter(([key]) => typeof lookup(messages, key) !== "string")
        .map(([key, file]) => `${key} (${file})`);
      expect(missing).toEqual([]);
    });

    it(`${locale}: every i18n.t path exists`, (): void => {
      const messages = catalog(locale);
      const missing = [...usages(APP_PATH, files)]
        .filter(([path]) => !pathExists(messages, path))
        .map(([path, file]) => `${path} (${file})`);
      expect(missing).toEqual([]);
    });
  }
});
